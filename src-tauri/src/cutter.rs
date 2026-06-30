//! The cut: a frame-accurate `ffmpeg` re-encode subprocess (H.264 / AAC, mp4).
//!
//! ClipSmith re-encodes every export with libx264 so the IN/OUT points are
//! frame-accurate — not limited to keyframe boundaries — and an optional crop
//! can be applied. libx264 is GPL, which is why ClipSmith is GPL (see LICENSE).
//!
//! The output is always mp4 (H.264 video + AAC audio): H.264 can't live in some
//! source containers (e.g. `.webm`), and a crop rewrites every pixel anyway, so
//! binding the output to the source container no longer makes sense. The first
//! video stream and all audio streams are kept; subtitles/attachments are
//! dropped, since they can't always be carried into mp4 (e.g. bitmap subs) and
//! keeping them would make the export fail on those sources.

use tauri::Emitter;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

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
        let even = |v: u32| v & !1;
        let w = even(self.w).max(2);
        let h = even(self.h).max(2);
        let x = even(self.x);
        let y = even(self.y);
        format!("crop={w}:{h}:{x}:{y}")
    }
}

/// Re-encode the range `[start, start + duration)` of `input` into `output` as a
/// frame-accurate H.264/AAC mp4, optionally cropped.
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
/// # Errors
/// Returns the trimmed ffmpeg stderr if the sidecar fails to spawn or exits
/// with a non-zero status.
pub async fn cut(
    app: &tauri::AppHandle,
    input: &str,
    output: &str,
    start: f64,
    duration: f64,
    crop: Option<Crop>,
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
        // First video + all audio; subtitles/attachments dropped (mp4 re-encode).
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        "0:a?".into(),
    ];

    if let Some(crop) = crop {
        args.push("-vf".into());
        args.push(crop.to_filter());
    }

    args.extend(
        [
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            "-avoid_negative_ts",
            "make_zero",
            "-y",
            output,
        ]
        .iter()
        .map(|s| (*s).to_string()),
    );

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
}
