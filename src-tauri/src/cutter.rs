//! The cut: a frame-accurate `ffmpeg` re-encode subprocess (H.264 / AAC, mp4).
//!
//! ClipSmith re-encodes every export with libx264 so the IN/OUT points are
//! frame-accurate — not limited to keyframe boundaries — and an optional
//! **reframe** can reshape the frame into a chosen output canvas. libx264 is GPL,
//! which is why ClipSmith is GPL (see LICENSE).
//!
//! The output is always mp4 (H.264 video + AAC audio): H.264 can't live in some
//! source containers (e.g. `.webm`), and a reframe rewrites every pixel anyway, so
//! binding the output to the source container no longer makes sense. The first
//! video stream and all audio streams are kept; subtitles/attachments are
//! dropped, since they can't always be carried into mp4 (e.g. bitmap subs) and
//! keeping them would make the export fail on those sources.
//!
//! ## Reframe (v2)
//!
//! v1 had a single destructive `crop=w:h:x:y` filter. v2 generalizes this into a
//! [`Reframe`]: the user picks an output **canvas** (`canvas_w` × `canvas_h`, even)
//! and a [`Strategy`] for how the source fills it:
//!
//! - [`Strategy::Blur`] — fit the whole frame inside the canvas, fill the leftover
//!   bars with a blurred, zoomed copy of the same video. Nothing is cropped away.
//!   This is a complex filtergraph (`split`/`overlay`), so it uses
//!   `-filter_complex` and maps the named `[v]` output.
//! - [`Strategy::Pad`] — same fit, but solid-color bars ([`Reframe::pad_color`]).
//! - [`Strategy::Crop`] — scale up and crop to the canvas (loses edges). With an
//!   explicit [`Reframe::crop`] rectangle it crops that region then scales it to
//!   the canvas. When the canvas equals the crop rectangle's own (even) size, no
//!   scale is appended, which is exactly v1's lossless-framing `crop=` filter (the
//!   "Freeform" escape hatch in the UI: arbitrary rectangle, output == rectangle).
//!
//! Canvas dimensions are computed on the frontend (single source of truth, so the
//! live preview and the export agree) and passed here as even integers. `[Pad]`
//! and `[Crop]` are simple `-vf` chains; `[Blur]` is a complex filtergraph.

use tauri::Emitter;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::encoders::VideoEncoder;
use crate::formats::OutputFormat;

/// The output encoding: target container/codecs plus the H.264 encoder flavour
/// (the encoder is ignored for non-H.264 formats like WebM).
#[derive(Debug, Clone, Copy)]
pub struct Encoding {
    pub format: OutputFormat,
    pub encoder: VideoEncoder,
}

/// An optional crop rectangle, in source pixels. libx264 with yuv420p needs even
/// width/height, so the values are rounded to even (and offsets to even, to keep
/// chroma aligned) before building the filter.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
pub struct Crop {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl Crop {
    /// Build the `crop=w:h:x:y` filter string with even, in-bounds values.
    fn to_filter(self) -> String {
        let w = even(self.w);
        let h = even(self.h);
        let x = even_floor(self.x);
        let y = even_floor(self.y);
        format!("crop={w}:{h}:{x}:{y}")
    }

    /// The crop rectangle's own (even) output dimensions.
    fn even_dims(self) -> (u32, u32) {
        (even(self.w), even(self.h))
    }
}

/// Round down to the nearest even value, with a floor of 2 (libx264 + yuv420p
/// require even, non-zero dimensions).
fn even(v: u32) -> u32 {
    (v & !1).max(2)
}

/// Round an offset down to even (offsets may legitimately be 0).
fn even_floor(v: u32) -> u32 {
    v & !1
}

/// How the source fills the output canvas. Matches the frontend `FillStrategy`
/// union (`"blur" | "pad" | "crop"`), lowercased.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Strategy {
    Blur,
    Pad,
    Crop,
}

/// Where the fitted source (or the kept crop region) sits within the canvas along
/// the axis that has bars. Matches the frontend `Anchor` union; applied to both
/// axes as an expression, so it's a no-op on the axis without bars.
#[derive(Debug, Clone, Copy, Default, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Anchor {
    /// Top (portrait canvas) / left (landscape canvas).
    Start,
    #[default]
    Center,
    /// Bottom (portrait canvas) / right (landscape canvas).
    End,
}

impl Anchor {
    /// `(x, y)` offset expressions for the `pad` filter, where `ow`/`oh` are the
    /// pad output (canvas) size and `iw`/`ih` the scaled-source size.
    fn pad_xy(self) -> (&'static str, &'static str) {
        match self {
            Anchor::Start => ("0", "0"),
            Anchor::Center => ("(ow-iw)/2", "(oh-ih)/2"),
            Anchor::End => ("ow-iw", "oh-ih"),
        }
    }

    /// `(x, y)` offset expressions for the `overlay` filter, where `W`/`H` are the
    /// background (canvas) size and `w`/`h` the foreground (fitted-source) size.
    fn overlay_xy(self) -> (&'static str, &'static str) {
        match self {
            Anchor::Start => ("0", "0"),
            Anchor::Center => ("(W-w)/2", "(H-h)/2"),
            Anchor::End => ("W-w", "H-h"),
        }
    }
}

/// A reframe: reshape the source into a chosen output canvas via a fill strategy.
/// Canvas dimensions arrive as even integers computed on the frontend.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reframe {
    pub canvas_w: u32,
    pub canvas_h: u32,
    pub strategy: Strategy,
    #[serde(default)]
    pub anchor: Anchor,
    /// `#RRGGBB` bar color for [`Strategy::Pad`]; defaults to black.
    #[serde(default)]
    pub pad_color: Option<String>,
    /// Explicit crop rectangle for [`Strategy::Crop`] (source pixels).
    #[serde(default)]
    pub crop: Option<Crop>,
}

/// The video filter to apply, if any. `Simple` becomes `-vf`; `Complex` becomes
/// `-filter_complex` with a named `[v]` output that the export maps.
enum VideoFilter {
    None,
    Simple(String),
    Complex(String),
}

impl Reframe {
    /// Translate the reframe into a video filter. Returns [`VideoFilter::None`]
    /// when the reframe is a no-op (a crop strategy with no rectangle).
    fn to_filter(&self) -> VideoFilter {
        let w = even(self.canvas_w);
        let h = even(self.canvas_h);

        match self.strategy {
            Strategy::Crop => {
                let Some(crop) = self.crop else {
                    return VideoFilter::None;
                };
                let base = crop.to_filter();
                // When the canvas matches the crop's own size, there's nothing to
                // scale: this is v1's lossless-framing `crop=` filter verbatim
                // (the "Freeform" escape hatch — arbitrary rect, output == rect).
                if crop.even_dims() == (w, h) {
                    VideoFilter::Simple(base)
                } else {
                    VideoFilter::Simple(format!("{base},scale={w}:{h},setsar=1"))
                }
            }
            Strategy::Pad => {
                let color = self.color_arg();
                let (x, y) = self.anchor.pad_xy();
                VideoFilter::Simple(format!(
                    "scale={w}:{h}:force_original_aspect_ratio=decrease,\
                     pad={w}:{h}:{x}:{y}:{color},setsar=1"
                ))
            }
            Strategy::Blur => {
                // Blur strength scales with the canvas so small and large outputs
                // read the same. Clamped so it neither vanishes nor melts detail.
                let sigma = (f64::from(w.min(h)) * 0.04).clamp(10.0, 40.0);
                let (ox, oy) = self.anchor.overlay_xy();
                VideoFilter::Complex(format!(
                    "[0:v]split=2[bg][fg];\
                     [bg]scale={w}:{h}:force_original_aspect_ratio=increase,\
                     crop={w}:{h},gblur=sigma={sigma:.2}[bgb];\
                     [fg]scale={w}:{h}:force_original_aspect_ratio=decrease[fgs];\
                     [bgb][fgs]overlay={ox}:{oy},setsar=1[v]"
                ))
            }
        }
    }

    /// The pad bar color as an ffmpeg color argument. `#RRGGBB` becomes
    /// `0xRRGGBB`; anything else is passed through; missing/empty is `black`.
    fn color_arg(&self) -> String {
        match self.pad_color.as_deref() {
            Some(s) if s.len() == 7 && s.starts_with('#') => format!("0x{}", &s[1..]),
            Some(s) if !s.is_empty() => s.to_string(),
            _ => "black".to_string(),
        }
    }
}

/// Re-encode the range `[start, start + duration)` of `input` into `output` as a
/// frame-accurate H.264/AAC mp4, optionally reframed.
///
/// `-ss` is placed **before** `-i`: when re-encoding, ffmpeg fast-seeks to the
/// preceding keyframe and then decodes/discards up to `start`, so the cut is both
/// fast and frame-accurate (unlike `-c copy`, which can only start on a
/// keyframe). `-y` overwrites without prompting — the save dialog already
/// confirmed the path and the sidecar has no stdin to answer ffmpeg.
///
/// Emits `export-progress` events (`0.0`-`1.0`, parsed from ffmpeg's `time=`)
/// while running, and a final `1.0` on success.
///
/// `encoding` selects the output container + codecs (mp4/mov/mkv = H.264/AAC,
/// webm = VP9/Opus) and, for H.264, the encoder flavour — libx264 (default) or a
/// detected hardware encoder (see [`crate::encoders`]). The trim and reframe are
/// codec-agnostic.
///
/// # Errors
/// Returns the trimmed ffmpeg stderr if the sidecar fails to spawn or exits
/// with a non-zero status.
pub async fn cut(
    app: &tauri::AppHandle,
    input: &str,
    output: &str,
    start: f64,
    duration: f64,
    reframe: Option<Reframe>,
    encoding: Encoding,
) -> Result<(), String> {
    let start_s = format!("{start:.6}");
    let duration_s = format!("{duration:.6}");

    let mut args: Vec<String> = vec![
        "-ss".into(),
        start_s,
        "-i".into(),
        input.to_string(),
        "-t".into(),
        duration_s,
    ];

    // Choose the video filter and the matching output mapping. A complex graph
    // (blur) names its output `[v]`; simple chains (pad/crop) and the no-filter
    // path both filter/keep the first video stream directly.
    let filter = reframe.map_or(VideoFilter::None, |r| r.to_filter());
    match &filter {
        VideoFilter::None => {
            args.extend(["-map", "0:v:0", "-map", "0:a?"].iter().map(|s| (*s).to_string()));
        }
        VideoFilter::Simple(vf) => {
            args.push("-vf".into());
            args.push(vf.clone());
            args.extend(["-map", "0:v:0", "-map", "0:a?"].iter().map(|s| (*s).to_string()));
        }
        VideoFilter::Complex(fc) => {
            args.push("-filter_complex".into());
            args.push(fc.clone());
            args.extend(["-map", "[v]", "-map", "0:a?"].iter().map(|s| (*s).to_string()));
        }
    }

    // Video + audio codecs, container flags, muxer, and output path — all chosen
    // by the target format (the H.264 encoder is folded in for mp4/mov/mkv).
    args.extend(encoding.format.encode_args(encoding.encoder, output));

    let (mut rx, _child) = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("failed to locate ffmpeg sidecar: {e}"))?
        .args(args)
        .spawn()
        .map_err(|e| format!("failed to run ffmpeg: {e}"))?;

    // ffmpeg writes its periodic `frame=… time=…` progress to stderr; the final
    // error summary (if it fails) goes there too, so we keep the tail of it.
    let mut errors = String::new();
    let total = duration.max(f64::MIN_POSITIVE);
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                if let Some(secs) = parse_progress_time(&line) {
                    let p = (secs / total).clamp(0.0, 1.0);
                    let _ = app.emit("export-progress", p);
                } else {
                    errors.push_str(&line);
                }
            }
            CommandEvent::Error(e) => errors.push_str(&e),
            CommandEvent::Terminated(payload) if payload.code != Some(0) => {
                return Err(format!("ffmpeg exited with an error: {}", errors.trim()));
            }
            _ => {}
        }
    }

    let _ = app.emit("export-progress", 1.0_f64);
    Ok(())
}

/// Parse the seconds value out of an ffmpeg progress line's `time=HH:MM:SS.xx`
/// field. Returns `None` for lines without a parseable timestamp (e.g. `N/A`).
fn parse_progress_time(s: &str) -> Option<f64> {
    let idx = s.rfind("time=")?;
    let token: String = s[idx + 5..]
        .chars()
        .take_while(|c| !c.is_whitespace())
        .collect();
    let mut parts = token.split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let sec: f64 = parts.next()?.parse().ok()?;
    Some((h * 3600.0 + m * 60.0 + sec).max(0.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_time_field() {
        let line = "frame=  120 fps= 30 q=28.0 size=  256kB time=00:00:04.00 bitrate=...";
        let secs = parse_progress_time(line).expect("should parse");
        assert!((secs - 4.0).abs() < 1e-9);
    }

    #[test]
    fn rejects_na_time() {
        assert!(parse_progress_time("time=N/A bitrate=N/A").is_none());
        assert!(parse_progress_time("no timestamp here").is_none());
    }

    #[test]
    fn crop_filter_is_even_and_bounded() {
        let c = Crop { x: 11, y: 7, w: 101, h: 51 };
        assert_eq!(c.to_filter(), "crop=100:50:10:6");
    }

    /// Helper: unwrap the filter string, failing on the wrong variant.
    fn simple(r: &Reframe) -> String {
        match r.to_filter() {
            VideoFilter::Simple(s) => s,
            _ => panic!("expected a simple -vf chain"),
        }
    }
    fn complex(r: &Reframe) -> String {
        match r.to_filter() {
            VideoFilter::Complex(s) => s,
            _ => panic!("expected a complex filtergraph"),
        }
    }

    #[test]
    fn freeform_crop_is_plain_v1_crop_filter() {
        // Canvas == crop dims → no scale appended, identical to v1's `crop=`.
        let r = Reframe {
            canvas_w: 100,
            canvas_h: 50,
            strategy: Strategy::Crop,
            anchor: Anchor::Center,
            pad_color: None,
            crop: Some(Crop { x: 10, y: 6, w: 100, h: 50 }),
        };
        assert_eq!(simple(&r), "crop=100:50:10:6");
    }

    #[test]
    fn crop_to_fill_scales_region_to_canvas() {
        let r = Reframe {
            canvas_w: 1080,
            canvas_h: 1920,
            strategy: Strategy::Crop,
            anchor: Anchor::Center,
            pad_color: None,
            crop: Some(Crop { x: 0, y: 0, w: 540, h: 960 }),
        };
        assert_eq!(simple(&r), "crop=540:960:0:0,scale=1080:1920,setsar=1");
    }

    #[test]
    fn crop_without_rect_is_noop() {
        let r = Reframe {
            canvas_w: 640,
            canvas_h: 480,
            strategy: Strategy::Crop,
            anchor: Anchor::Center,
            pad_color: None,
            crop: None,
        };
        assert!(matches!(r.to_filter(), VideoFilter::None));
    }

    #[test]
    fn pad_uses_color_and_anchor() {
        let r = Reframe {
            canvas_w: 1080,
            canvas_h: 1920,
            strategy: Strategy::Pad,
            anchor: Anchor::Start,
            pad_color: Some("#112233".to_string()),
            crop: None,
        };
        assert_eq!(
            simple(&r),
            "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:0:0:0x112233,setsar=1"
        );
    }

    #[test]
    fn pad_defaults_to_black_and_centers() {
        let r = Reframe {
            canvas_w: 1000,
            canvas_h: 1000,
            strategy: Strategy::Pad,
            anchor: Anchor::Center,
            pad_color: None,
            crop: None,
        };
        assert_eq!(
            simple(&r),
            "scale=1000:1000:force_original_aspect_ratio=decrease,pad=1000:1000:(ow-iw)/2:(oh-ih)/2:black,setsar=1"
        );
    }

    #[test]
    fn blur_builds_split_overlay_graph_with_v_output() {
        let r = Reframe {
            canvas_w: 1080,
            canvas_h: 1920,
            strategy: Strategy::Blur,
            anchor: Anchor::Center,
            pad_color: None,
            crop: None,
        };
        let g = complex(&r);
        assert!(g.starts_with("[0:v]split=2[bg][fg];"));
        assert!(g.contains("force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma="));
        assert!(g.contains("force_original_aspect_ratio=decrease[fgs]"));
        assert!(g.ends_with("overlay=(W-w)/2:(H-h)/2,setsar=1[v]"));
    }

    #[test]
    fn canvas_dims_are_forced_even() {
        // Odd canvas from the frontend must be evened before hitting libx264.
        let r = Reframe {
            canvas_w: 1081,
            canvas_h: 1921,
            strategy: Strategy::Pad,
            anchor: Anchor::Center,
            pad_color: None,
            crop: None,
        };
        assert!(simple(&r).contains("scale=1080:1920:"));
    }
}
