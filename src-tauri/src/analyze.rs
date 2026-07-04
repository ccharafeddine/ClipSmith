//! Analyze pass for subject-aware auto-reframe (v2 Tier 2, M1).
//!
//! Phase one of the two-phase pipeline: sample frames from the source, run the
//! bundled detectors, and emit **raw per-frame detections**. Turning those into a
//! smoothed, tracked crop path (M2) and driving a time-varying crop (M3) come
//! later — keeping the expensive, ratio-independent detection separate from the
//! cheap, ratio-dependent path so a canvas-ratio change never re-detects.
//!
//! Frames are piped straight from ffmpeg as raw `rgb24` (reusing the
//! `filmstrip.rs` `set_raw_out(true)` binary-stdout pattern — no temp files),
//! scaled by ffmpeg to each detector's native input size so there's no image
//! resizing in Rust. The pass is cancellable (the URL-import `AtomicBool`
//! pattern) and emits `analyze-progress` (0.0-1.0).
//!
//! ## Status
//!
//! M1 currently ships the **face** path (Ultraface). The person path (NanoDet)
//! folds into the same loop next; the [`SubjectFrame`] output already carries a
//! `persons` list so the shape is stable.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tract_onnx::prelude::*;

/// A detection box in **normalized source coordinates** (`0.0`-`1.0`, so it's
/// resolution- and letterbox-independent) plus its confidence.
#[derive(Clone, Copy, Debug, serde::Serialize)]
pub struct Det {
    pub x1: f32,
    pub y1: f32,
    pub x2: f32,
    pub y2: f32,
    pub score: f32,
}

impl Det {
    fn area(self) -> f32 {
        ((self.x2 - self.x1) * (self.y2 - self.y1)).max(0.0)
    }

    /// Intersection-over-union with another box.
    fn iou(self, o: Det) -> f32 {
        let ix1 = self.x1.max(o.x1);
        let iy1 = self.y1.max(o.y1);
        let ix2 = self.x2.min(o.x2);
        let iy2 = self.y2.min(o.y2);
        let iw = (ix2 - ix1).max(0.0);
        let ih = (iy2 - iy1).max(0.0);
        let inter = iw * ih;
        let union = self.area() + o.area() - inter;
        if union <= 0.0 {
            0.0
        } else {
            inter / union
        }
    }
}

/// Detections in one sampled frame, at time `t` seconds.
#[derive(Clone, Debug, serde::Serialize)]
pub struct SubjectFrame {
    pub t: f64,
    pub faces: Vec<Det>,
    pub persons: Vec<Det>,
}

/// Greedy non-maximum suppression: keep the highest-scoring boxes, dropping any
/// that overlap an already-kept box by more than `iou_thr`.
fn nms(mut dets: Vec<Det>, iou_thr: f32) -> Vec<Det> {
    dets.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut keep: Vec<Det> = Vec::new();
    'outer: for d in dets {
        for k in &keep {
            if d.iou(*k) > iou_thr {
                continue 'outer;
            }
        }
        keep.push(d);
    }
    keep
}

/// Decode Ultraface's two outputs into boxes. `scores` is the flat `[N,2]`
/// softmax (background, face) and `boxes` the flat `[N,4]` corner coordinates
/// already normalized to `0.0`-`1.0`. Keeps faces above `score_thr`, then NMS.
fn decode_ultraface(scores: &[f32], boxes: &[f32], score_thr: f32, iou_thr: f32) -> Vec<Det> {
    let n = (scores.len() / 2).min(boxes.len() / 4);
    let mut dets = Vec::new();
    for i in 0..n {
        let p = scores[i * 2 + 1];
        if p >= score_thr {
            dets.push(Det {
                x1: boxes[i * 4],
                y1: boxes[i * 4 + 1],
                x2: boxes[i * 4 + 2],
                y2: boxes[i * 4 + 3],
                score: p,
            });
        }
    }
    nms(dets, iou_thr)
}

// Ultraface RFB-320: fixed input, direct resize (no letterbox), (x-127)/128.
const FACE_W: usize = 320;
const FACE_H: usize = 240;
const FACE_SCORE_THR: f32 = 0.7;
const FACE_IOU_THR: f32 = 0.3;

/// Resolve a bundled model path. Debug builds read `src-tauri/models` directly
/// (so `tauri dev` works after `scripts/fetch-models.sh`); release builds resolve
/// the file from the Tauri resource dir. Mirrors `commands::exports_dir`.
fn model_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        return Ok(std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("models")
            .join(name));
    }
    app.path()
        .resolve(
            format!("models/{name}"),
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| format!("could not locate the detector model {name}: {e}"))
}

/// A loaded, optimized, runnable ONNX model. `into_runnable()` hands back an
/// `Arc`-wrapped plan in tract 0.23, so the alias matches that.
type Runnable = std::sync::Arc<TypedRunnableModel>;

/// Load + optimize + make runnable an ONNX model with a fixed NCHW input.
fn load_model(path: &PathBuf, c: usize, h: usize, w: usize) -> Result<Runnable, String> {
    let model = tract_onnx::onnx()
        .model_for_path(path)
        .map_err(|e| format!("could not read the detector model: {e}"))?
        .with_input_fact(0, f32::fact([1, c, h, w]).into())
        .map_err(|e| format!("could not shape the detector input: {e}"))?
        .into_optimized()
        .map_err(|e| format!("could not optimize the detector model: {e}"))?
        .into_runnable()
        .map_err(|e| format!("could not ready the detector model: {e}"))?;
    Ok(model)
}

/// Run Ultraface on one `FACE_W`×`FACE_H` `rgb24` frame → face boxes (normalized).
fn detect_faces(model: &Runnable, frame: &[u8]) -> Result<Vec<Det>, String> {
    // rgb24 HWC → NCHW f32, normalized (x-127)/128.
    let mut data = vec![0f32; 3 * FACE_H * FACE_W];
    for y in 0..FACE_H {
        for x in 0..FACE_W {
            let px = (y * FACE_W + x) * 3;
            for c in 0..3 {
                data[c * FACE_H * FACE_W + y * FACE_W + x] =
                    (f32::from(frame[px + c]) - 127.0) / 128.0;
            }
        }
    }
    let input = Tensor::from_shape(&[1, 3, FACE_H, FACE_W], &data)
        .map_err(|e| format!("failed to build the detector input: {e}"))?;
    let out = model
        .run(tvec!(input.into()))
        .map_err(|e| format!("face detection failed: {e}"))?;
    // TValue derefs to Tensor; a tensor view's `as_slice` returns the flat
    // row-major data borrowing the tensor (not the temporary view), so reading
    // it inline is fine.
    let scores_t: &Tensor = &out[0];
    let boxes_t: &Tensor = &out[1];
    let scores = scores_t
        .view()
        .as_slice::<f32>()
        .map_err(|e| format!("unexpected detector output: {e}"))?;
    let boxes = boxes_t
        .view()
        .as_slice::<f32>()
        .map_err(|e| format!("unexpected detector output: {e}"))?;
    Ok(decode_ultraface(
        scores,
        boxes,
        FACE_SCORE_THR,
        FACE_IOU_THR,
    ))
}

// NanoDet-Plus-m 416 (person). Direct resize (same as the face pass, so boxes
// come back in source-normalized coords with no letterbox math), BGR channel
// order with ImageNet mean/std. Single output `[1, P, 80+4*8]`: 80 COCO class
// logits (person = class 0) + a distribution-focal-loss box (4 sides × 8 bins).
//
// MAINTAINER NOTE: the NanoDet decode below encodes several model-specific
// assumptions that could not be validated on a real-people clip in this
// environment — the class/reg split order, the level/point ordering, the
// grid-center 0.5 offset, the [left,top,right,bottom] side order, and the BGR
// mean/std normalization. The *math* (DFL expectation, prior count, NMS) is
// unit-tested; confirm end-to-end detection on live-action footage and tune
// these constants if persons don't track.
const PERSON_W: usize = 416;
const PERSON_H: usize = 416;
const PERSON_SCORE_THR: f32 = 0.4;
const PERSON_IOU_THR: f32 = 0.5;
const NANODET_STRIDES: [usize; 4] = [8, 16, 32, 64];
const NANODET_REG_MAX: usize = 7; // 8 bins per box side
const NANODET_CLASSES: usize = 80;
const PERSON_CLASS: usize = 0; // COCO index for "person"
const NANODET_CH: usize = NANODET_CLASSES + 4 * (NANODET_REG_MAX + 1); // 112
const NANODET_MEAN: [f32; 3] = [103.53, 116.28, 123.675]; // BGR
const NANODET_STD: [f32; 3] = [57.375, 57.12, 58.395]; // BGR

fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}

/// The expected value of a distribution-focal-loss side: softmax over the bins,
/// then `Σ j·softmaxⱼ`. Gives the (sub-integer) distance in stride units.
fn dfl_expectation(bins: &[f32]) -> f32 {
    let max = bins.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let exps: Vec<f32> = bins.iter().map(|v| (v - max).exp()).collect();
    let sum: f32 = exps.iter().sum();
    if sum <= 0.0 {
        return 0.0;
    }
    exps.iter()
        .enumerate()
        .map(|(j, e)| j as f32 * e / sum)
        .sum()
}

/// Grid-cell centers `(cx, cy, stride)` in input pixels, in the same order as the
/// model's flattened output points (each stride level, row-major). Totals 3598
/// for 416 with strides 8/16/32/64.
fn nanodet_priors() -> Vec<(f32, f32, f32)> {
    let mut priors = Vec::new();
    for &s in &NANODET_STRIDES {
        let grid = PERSON_W.div_ceil(s);
        for gy in 0..grid {
            for gx in 0..grid {
                priors.push((
                    (gx as f32 + 0.5) * s as f32,
                    (gy as f32 + 0.5) * s as f32,
                    s as f32,
                ));
            }
        }
    }
    priors
}

/// Decode NanoDet's flat `[P, NANODET_CH]` output into person boxes (normalized),
/// keeping class-0 (person) points above `score_thr`, then NMS.
fn decode_nanodet(
    out: &[f32],
    priors: &[(f32, f32, f32)],
    score_thr: f32,
    iou_thr: f32,
) -> Vec<Det> {
    let bins = NANODET_REG_MAX + 1;
    let mut dets = Vec::new();
    for (i, &(cx, cy, s)) in priors.iter().enumerate() {
        let base = i * NANODET_CH;
        if base + NANODET_CH > out.len() {
            break;
        }
        let score = sigmoid(out[base + PERSON_CLASS]);
        if score < score_thr {
            continue;
        }
        let reg = &out[base + NANODET_CLASSES..base + NANODET_CH];
        let dl = dfl_expectation(&reg[0..bins]) * s;
        let dt = dfl_expectation(&reg[bins..2 * bins]) * s;
        let dr = dfl_expectation(&reg[2 * bins..3 * bins]) * s;
        let db = dfl_expectation(&reg[3 * bins..4 * bins]) * s;
        dets.push(Det {
            x1: (cx - dl) / PERSON_W as f32,
            y1: (cy - dt) / PERSON_H as f32,
            x2: (cx + dr) / PERSON_W as f32,
            y2: (cy + db) / PERSON_H as f32,
            score,
        });
    }
    nms(dets, iou_thr)
}

/// Run NanoDet on one `PERSON_W`×`PERSON_H` `rgb24` frame → person boxes.
fn detect_persons(model: &Runnable, frame: &[u8]) -> Result<Vec<Det>, String> {
    const HW: usize = PERSON_H * PERSON_W;
    let mut data = vec![0f32; 3 * HW];
    for y in 0..PERSON_H {
        for x in 0..PERSON_W {
            let px = (y * PERSON_W + x) * 3;
            let (r, g, b) = (
                f32::from(frame[px]),
                f32::from(frame[px + 1]),
                f32::from(frame[px + 2]),
            );
            let i = y * PERSON_W + x;
            // BGR channel order.
            data[i] = (b - NANODET_MEAN[0]) / NANODET_STD[0];
            data[HW + i] = (g - NANODET_MEAN[1]) / NANODET_STD[1];
            data[2 * HW + i] = (r - NANODET_MEAN[2]) / NANODET_STD[2];
        }
    }
    let input = Tensor::from_shape(&[1, 3, PERSON_H, PERSON_W], &data)
        .map_err(|e| format!("failed to build the detector input: {e}"))?;
    let out = model
        .run(tvec!(input.into()))
        .map_err(|e| format!("person detection failed: {e}"))?;
    let t: &Tensor = &out[0];
    let flat = t
        .view()
        .as_slice::<f32>()
        .map_err(|e| format!("unexpected detector output: {e}"))?;
    Ok(decode_nanodet(
        flat,
        &nanodet_priors(),
        PERSON_SCORE_THR,
        PERSON_IOU_THR,
    ))
}

/// Shared flag the running analyze pass polls so the frontend can cancel it.
#[derive(Default)]
pub struct AnalyzeCancel(pub Arc<AtomicBool>);

/// Request the in-progress analyze pass to abort.
#[tauri::command]
pub fn cancel_analyze(cancel: State<'_, AnalyzeCancel>) {
    cancel.0.store(true, Ordering::SeqCst);
}

/// User-facing message when analysis is cancelled; the frontend swallows it.
const ANALYZE_CANCELLED: &str = "Analysis cancelled.";

/// Resolve once `flag` is set, so a stalled ffmpeg pipe can still be aborted.
async fn cancelled(flag: &AtomicBool) {
    while !flag.load(Ordering::SeqCst) {
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
    }
}

/// One detection pass: pipe frames from ffmpeg at `w`×`h` `rgb24` and run
/// `detect` on each, returning its boxes per frame. Emits `analyze-progress`
/// spanning `[prog_base, prog_base + prog_span]` and is cancellable. Shared by
/// the face and person passes (which differ only in model + input size), so the
/// pipe / drain / cancel plumbing lives in one place.
#[allow(clippy::too_many_arguments)]
async fn run_pass(
    app: &AppHandle,
    input: &str,
    fps: f64,
    flag: &AtomicBool,
    model: &Runnable,
    w: usize,
    h: usize,
    detect: fn(&Runnable, &[u8]) -> Result<Vec<Det>, String>,
    total_frames: usize,
    prog_base: f64,
    prog_span: f64,
) -> Result<Vec<Vec<Det>>, String> {
    let vf = format!("fps={fps},scale={w}:{h}");
    let args = [
        "-v", "error", "-i", input, "-vf", &vf, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ];
    let (mut rx, child) = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("could not locate ffmpeg: {e}"))?
        .args(args)
        .set_raw_out(true)
        .spawn()
        .map_err(|e| format!("ffmpeg failed to start: {e}"))?;

    let frame_bytes = w * h * 3;
    let mut buf: Vec<u8> = Vec::with_capacity(frame_bytes * 2);
    let mut out: Vec<Vec<Det>> = Vec::new();
    let mut idx = 0usize;
    let mut stderr = String::new();

    loop {
        let event = tokio::select! {
            biased;
            () = cancelled(flag) => {
                let _ = child.kill();
                return Err(ANALYZE_CANCELLED.to_string());
            }
            ev = rx.recv() => match ev {
                Some(ev) => ev,
                None => break,
            },
        };
        match event {
            CommandEvent::Stdout(chunk) => {
                buf.extend_from_slice(&chunk);
                while buf.len() >= frame_bytes {
                    let frame: Vec<u8> = buf.drain(..frame_bytes).collect();
                    out.push(detect(model, &frame)?);
                    idx += 1;
                    let frac = (idx as f64 / total_frames as f64).clamp(0.0, 1.0);
                    let _ = app.emit("analyze-progress", (prog_base + prog_span * frac).min(1.0));
                }
            }
            CommandEvent::Stderr(chunk) => {
                stderr.push_str(&String::from_utf8_lossy(&chunk));
            }
            CommandEvent::Terminated(payload) if payload.code != Some(0) => {
                return Err(format!("analysis failed: {}", stderr.trim()));
            }
            _ => {}
        }
    }
    Ok(out)
}

/// Scene-change score threshold for a hard cut (ffmpeg `scene` metric, 0-1).
const SCENE_THR: f32 = 0.4;

/// Parse `pts_time:` timestamps out of ffmpeg's `metadata=print` output — one per
/// scene-change frame the `select` passed. Sorted, de-duplicated.
fn parse_scene_cuts(text: &str) -> Vec<f64> {
    let mut cuts: Vec<f64> = text
        .lines()
        .filter_map(|line| {
            let idx = line.find("pts_time:")?;
            let rest = &line[idx + "pts_time:".len()..];
            let num: String = rest
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect();
            num.parse::<f64>().ok()
        })
        .collect();
    cuts.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    cuts.dedup();
    cuts
}

/// Detect scene-cut timestamps (seconds) with a cheap ffmpeg pass: score each
/// frame's scene change, keep those over [`SCENE_THR`], and print their times.
/// Downscaled for speed; the score is relative, so the small size is fine.
/// Cancellable via `flag`.
async fn detect_scene_cuts(
    app: &AppHandle,
    input: &str,
    flag: &AtomicBool,
) -> Result<Vec<f64>, String> {
    // metadata=print:file=- writes to stdout (not the -v error-suppressed log).
    let vf = format!("scale=320:-2,select='gt(scene,{SCENE_THR})',metadata=print:file=-");
    let args = [
        "-v", "error", "-i", input, "-an", "-vf", &vf, "-f", "null", "-",
    ];
    let (mut rx, child) = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("could not locate ffmpeg: {e}"))?
        .args(args)
        .spawn()
        .map_err(|e| format!("ffmpeg failed to start: {e}"))?;

    let mut text = String::new();
    let mut stderr = String::new();
    loop {
        let event = tokio::select! {
            biased;
            () = cancelled(flag) => {
                let _ = child.kill();
                return Err(ANALYZE_CANCELLED.to_string());
            }
            ev = rx.recv() => match ev {
                Some(ev) => ev,
                None => break,
            },
        };
        match event {
            CommandEvent::Stdout(chunk) => text.push_str(&String::from_utf8_lossy(&chunk)),
            CommandEvent::Stderr(chunk) => stderr.push_str(&String::from_utf8_lossy(&chunk)),
            CommandEvent::Terminated(payload) if payload.code != Some(0) => {
                return Err(format!("scene detection failed: {}", stderr.trim()));
            }
            _ => {}
        }
    }
    Ok(parse_scene_cuts(&text))
}

/// The analyze pass result: per-frame detections plus scene-cut times.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeResult {
    pub frames: Vec<SubjectFrame>,
    pub scene_cuts: Vec<f64>,
}

/// Analyze `input` for subjects: sample it at `fps` (default 3) and return
/// per-frame face + person detections plus scene-cut times. Runs the two
/// detectors as separate ffmpeg passes (each needs its own input size) then a
/// cheap scene-cut pass; frames align by index since both detectors use the same
/// `fps`. `duration` (seconds) drives the progress estimate. Emits
/// `analyze-progress` (0.0-1.0) and is cancellable via [`cancel_analyze`].
///
/// # Errors
/// Returns a user-facing message if a model can't load, ffmpeg fails, or the
/// pass is cancelled.
#[tauri::command]
pub async fn analyze_subject(
    app: AppHandle,
    cancel: State<'_, AnalyzeCancel>,
    input: String,
    duration: f64,
    fps: Option<f64>,
) -> Result<AnalyzeResult, String> {
    if input.starts_with('-') {
        return Err("that file path isn't allowed".to_string());
    }
    let flag = cancel.0.clone();
    flag.store(false, Ordering::SeqCst);

    let fps = fps.unwrap_or(3.0).clamp(0.5, 15.0);
    let total = ((duration.max(0.0) * fps).ceil() as usize).max(1);

    let face_model = load_model(&model_path(&app, "ultraface-320.onnx")?, 3, FACE_H, FACE_W)?;
    let person_model = load_model(
        &model_path(&app, "nanodet-plus-m-416.onnx")?,
        3,
        PERSON_H,
        PERSON_W,
    )?;

    // Two detection passes (one per detector) split the first 90% of the
    // progress bar; the cheap scene-cut pass fills the rest.
    let faces = run_pass(
        &app,
        &input,
        fps,
        &flag,
        &face_model,
        FACE_W,
        FACE_H,
        detect_faces,
        total,
        0.0,
        0.45,
    )
    .await?;
    let persons = run_pass(
        &app,
        &input,
        fps,
        &flag,
        &person_model,
        PERSON_W,
        PERSON_H,
        detect_persons,
        total,
        0.45,
        0.45,
    )
    .await?;
    let scene_cuts = detect_scene_cuts(&app, &input, &flag).await?;

    let n = faces.len().max(persons.len());
    let mut frames = Vec::with_capacity(n);
    for i in 0..n {
        frames.push(SubjectFrame {
            t: i as f64 / fps,
            faces: faces.get(i).cloned().unwrap_or_default(),
            persons: persons.get(i).cloned().unwrap_or_default(),
        });
    }

    let _ = app.emit("analyze-progress", 1.0_f64);
    Ok(AnalyzeResult { frames, scene_cuts })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn det(x1: f32, y1: f32, x2: f32, y2: f32, s: f32) -> Det {
        Det {
            x1,
            y1,
            x2,
            y2,
            score: s,
        }
    }

    #[test]
    fn iou_is_correct_for_known_overlap() {
        // Two unit squares overlapping in a quarter.
        let a = det(0.0, 0.0, 1.0, 1.0, 1.0);
        let b = det(0.5, 0.5, 1.5, 1.5, 1.0);
        // intersection 0.25, union 1 + 1 - 0.25 = 1.75.
        assert!((a.iou(b) - 0.25 / 1.75).abs() < 1e-5);
        // Disjoint → 0.
        assert_eq!(a.iou(det(2.0, 2.0, 3.0, 3.0, 1.0)), 0.0);
    }

    #[test]
    fn nms_keeps_best_and_drops_overlaps() {
        let dets = vec![
            det(0.0, 0.0, 1.0, 1.0, 0.9),   // best
            det(0.05, 0.05, 1.0, 1.0, 0.8), // heavy overlap → dropped
            det(5.0, 5.0, 6.0, 6.0, 0.7),   // far away → kept
        ];
        let kept = nms(dets, 0.3);
        assert_eq!(kept.len(), 2);
        assert!((kept[0].score - 0.9).abs() < 1e-6);
        assert!((kept[1].score - 0.7).abs() < 1e-6);
    }

    #[test]
    fn parse_scene_cuts_extracts_sorted_unique_times() {
        let text = "\
frame:5    pts:370688  pts_time:12.345
lavfi.scene_score=0.512
frame:1    pts:30000   pts_time:1.5
lavfi.scene_score=0.470
frame:5    pts:370688  pts_time:12.345
";
        assert_eq!(parse_scene_cuts(text), vec![1.5, 12.345]);
        assert!(parse_scene_cuts("no timestamps here").is_empty());
    }

    #[test]
    fn nanodet_priors_total_matches_output_points() {
        // 52² + 26² + 13² + 7² = 3598, the model's point count for 416 input.
        assert_eq!(nanodet_priors().len(), 3598);
    }

    #[test]
    fn dfl_expectation_is_the_softmax_weighted_mean() {
        // Uniform logits → mean bin index (0..7) = 3.5.
        assert!((dfl_expectation(&[0.0; 8]) - 3.5).abs() < 1e-4);
        // A logit spike at index 5 dominates → close to 5.
        let mut bins = [0.0f32; 8];
        bins[5] = 50.0;
        assert!((dfl_expectation(&bins) - 5.0).abs() < 1e-3);
    }

    #[test]
    fn sigmoid_midpoint_and_bounds() {
        assert!((sigmoid(0.0) - 0.5).abs() < 1e-6);
        assert!(sigmoid(20.0) > 0.99);
        assert!(sigmoid(-20.0) < 0.01);
    }

    #[test]
    fn decode_ultraface_thresholds_and_orders() {
        // Three priors: a strong face, a weak one (below threshold), and another
        // strong one far away. scores are [bg, face] pairs.
        let scores = [
            0.1, 0.9, // face 0 strong
            0.7, 0.3, // face 1 weak → dropped
            0.2, 0.8, // face 2 strong
        ];
        let boxes = [
            0.0, 0.0, 0.2, 0.2, // 0
            0.4, 0.4, 0.5, 0.5, // 1
            0.7, 0.7, 0.9, 0.9, // 2
        ];
        let dets = decode_ultraface(&scores, &boxes, 0.7, 0.3);
        assert_eq!(dets.len(), 2);
        // Highest score first after NMS sort.
        assert!((dets[0].score - 0.9).abs() < 1e-6);
        assert!((dets[0].x2 - 0.2).abs() < 1e-6);
    }
}
