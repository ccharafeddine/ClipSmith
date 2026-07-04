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

/// Analyze `input` for subjects: sample it at `fps` (default 3), run the
/// detector on each frame, and return per-frame detections. `duration` (seconds)
/// is used only for the progress estimate. Emits `analyze-progress` (0.0-1.0)
/// and is cancellable via [`cancel_analyze`].
///
/// # Errors
/// Returns a user-facing message if the model can't load, ffmpeg fails, or the
/// pass is cancelled.
#[tauri::command]
pub async fn analyze_subject(
    app: AppHandle,
    cancel: State<'_, AnalyzeCancel>,
    input: String,
    duration: f64,
    fps: Option<f64>,
) -> Result<Vec<SubjectFrame>, String> {
    if input.starts_with('-') {
        return Err("that file path isn't allowed".to_string());
    }
    let flag = cancel.0.clone();
    flag.store(false, Ordering::SeqCst);

    let fps = fps.unwrap_or(3.0).clamp(0.5, 15.0);
    let face_model = load_model(&model_path(&app, "ultraface-320.onnx")?, 3, FACE_H, FACE_W)?;

    let vf = format!("fps={fps},scale={FACE_W}:{FACE_H}");
    let args = [
        "-v", "error", "-i", &input, "-vf", &vf, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ];
    let (mut rx, child) = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("could not locate ffmpeg: {e}"))?
        .args(args)
        .set_raw_out(true)
        .spawn()
        .map_err(|e| format!("ffmpeg failed to start: {e}"))?;

    const FRAME_BYTES: usize = FACE_W * FACE_H * 3;
    let total_frames = ((duration.max(0.0) * fps).ceil() as usize).max(1);
    let mut buf: Vec<u8> = Vec::with_capacity(FRAME_BYTES * 2);
    let mut frames: Vec<SubjectFrame> = Vec::new();
    let mut idx = 0usize;
    let mut stderr = String::new();

    loop {
        let event = tokio::select! {
            biased;
            () = cancelled(&flag) => {
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
                while buf.len() >= FRAME_BYTES {
                    let frame: Vec<u8> = buf.drain(..FRAME_BYTES).collect();
                    let faces = detect_faces(&face_model, &frame)?;
                    frames.push(SubjectFrame {
                        t: idx as f64 / fps,
                        faces,
                        persons: Vec::new(),
                    });
                    idx += 1;
                    let p = (idx as f64 / total_frames as f64).clamp(0.0, 1.0);
                    let _ = app.emit("analyze-progress", p);
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

    let _ = app.emit("analyze-progress", 1.0_f64);
    Ok(frames)
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
