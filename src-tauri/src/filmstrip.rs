//! Timeline preview strip: a single horizontal montage of thumbnails sampled
//! across the clip, used as the timeline backdrop.
//!
//! To honor ClipSmith's "zero intermediate files" constraint, ffmpeg writes the
//! PNG to **stdout** (`pipe:1`) rather than a temp file; we capture those bytes
//! and return them as a base64 data URI the `<img>` loads directly. No decode of
//! the whole video either — each thumbnail uses a fast keyframe seek
//! (`-ss` before `-i`), so this stays quick even on hour-long sources.

use base64::Engine as _;
use tauri_plugin_shell::ShellExt;

/// Number of thumbnails sampled across the clip.
const COUNT: u32 = 24;
/// Thumbnail height in pixels (width follows the center-crop aspect).
const HEIGHT: u32 = 144;

/// Build a horizontal thumbnail strip spanning the whole clip and return it as a
/// `data:image/png;base64,...` URI.
///
/// `duration_secs` is the source duration; thumbnails are sampled at evenly
/// spaced timestamps. The source is read in place and never modified, and no
/// file is written to disk.
///
/// # Errors
/// Returns a user-facing message if ffmpeg can't be located, fails to run, or
/// exits non-zero.
pub async fn generate(
    app: &tauri::AppHandle,
    path: &str,
    duration_secs: f64,
) -> Result<String, String> {
    let dur = if duration_secs > 0.05 { duration_secs } else { 1.0 };

    // One fast keyframe seek per thumbnail (open the input COUNT times at evenly
    // spaced timestamps); `-an` skips audio.
    let mut args: Vec<String> = vec!["-v".into(), "error".into()];
    for i in 0..COUNT {
        let t = (f64::from(i) + 0.5) * dur / f64::from(COUNT);
        args.push("-ss".into());
        args.push(format!("{t:.3}"));
        args.push("-an".into());
        args.push("-i".into());
        args.push(path.to_owned());
    }

    // Center-crop each frame to a tall-ish slice, scale to a common height, then
    // hstack them all into one strip.
    let mut fc = String::new();
    for i in 0..COUNT {
        fc.push_str(&format!(
            "[{i}:v]crop=min(iw\\,ih*0.7):ih,scale=-2:{HEIGHT},setsar=1[v{i}];"
        ));
    }
    for i in 0..COUNT {
        fc.push_str(&format!("[v{i}]"));
    }
    fc.push_str(&format!("hstack=inputs={COUNT}[out]"));

    args.extend([
        "-filter_complex".into(),
        fc,
        "-map".into(),
        "[out]".into(),
        "-frames:v".into(),
        "1".into(),
        // Encode a single PNG straight to stdout — no intermediate file.
        "-f".into(),
        "image2pipe".into(),
        "-vcodec".into(),
        "png".into(),
        "pipe:1".into(),
    ]);

    let output = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("could not locate ffmpeg: {e}"))?
        .args(args)
        .output()
        .await
        .map_err(|e| format!("ffmpeg failed to start: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("could not build filmstrip: {}", stderr.trim()));
    }

    let b64 = base64::engine::general_purpose::STANDARD.encode(&output.stdout);
    Ok(format!("data:image/png;base64,{b64}"))
}
