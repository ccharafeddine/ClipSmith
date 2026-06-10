//! Timeline preview strip: a single horizontal montage of thumbnails sampled
//! across the clip, used as the timeline backdrop.
//!
//! To honor ClipSmith's "zero intermediate files" constraint, ffmpeg writes the
//! PNG to **stdout** (`pipe:1`) rather than a temp file; we capture those bytes
//! and return them as a base64 data URI the `<img>` loads directly. No decode of
//! the whole video either — each thumbnail uses a fast keyframe seek
//! (`-ss` before `-i`), so this stays quick even on hour-long sources.

use base64::Engine as _;
use tauri_plugin_shell::process::CommandEvent;
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

    // NOTE: we must NOT use `.output()` here. Its convenience reader splits the
    // child's stdout on newlines and rejoins with `\n`, which mangles any binary
    // containing CRLF (`0x0D 0x0A`) — and a PNG is full of those. `set_raw_out`
    // + draining the events ourselves keeps the bytes byte-for-byte intact.
    let (mut rx, _child) = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("could not locate ffmpeg: {e}"))?
        .args(args)
        .set_raw_out(true)
        .spawn()
        .map_err(|e| format!("ffmpeg failed to start: {e}"))?;

    let mut png = Vec::new();
    let mut stderr = Vec::new();
    let mut code: Option<i32> = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(chunk) => png.extend(chunk),
            CommandEvent::Stderr(chunk) => stderr.extend(chunk),
            CommandEvent::Terminated(payload) => code = payload.code,
            CommandEvent::Error(e) => return Err(format!("ffmpeg error: {e}")),
            _ => {}
        }
    }

    if code != Some(0) {
        let msg = String::from_utf8_lossy(&stderr);
        return Err(format!("could not build filmstrip: {}", msg.trim()));
    }

    let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
    Ok(format!("data:image/png;base64,{b64}"))
}
