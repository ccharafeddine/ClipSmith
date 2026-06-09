//! The cut: a single `ffmpeg -c copy` stream-copy subprocess.
//!
//! Simple mode never re-encodes. We fast-seek the input to the (already
//! keyframe-snapped) start, copy every stream straight through for `duration`
//! seconds, and write the clip to `output`. No encoder is invoked, so no
//! encoder license is ever touched — this is what keeps ClipSmith LGPL-clean.

use tauri_plugin_shell::ShellExt;

/// Stream-copy the range `[start, start + duration)` of `input` into `output`.
///
/// `start` must already land on a keyframe — the frontend snaps the IN handle,
/// so the cut starts on a keyframe by construction; under `-c copy` only the
/// start has to. `output`'s extension must equal `input`'s so the muxer always
/// accepts the copied packets.
///
/// `start` and `duration` are formatted with microsecond precision to match
/// ffprobe's `pts_time`. `-y` overwrites without prompting: the save dialog has
/// already confirmed the path, and the sidecar has no stdin to answer ffmpeg's
/// overwrite question, so without `-y` the process would hang. The copy is
/// near-instant for short clips, so `.output()` (await to completion) is
/// correct here; progress streaming arrives in Step 9.
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
) -> Result<(), String> {
    let start = format!("{start:.6}");
    let duration = format!("{duration:.6}");

    let result = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("failed to locate ffmpeg sidecar: {e}"))?
        .args([
            "-ss",
            &start,
            "-i",
            input,
            "-t",
            &duration,
            "-map",
            "0",
            "-c",
            "copy",
            "-avoid_negative_ts",
            "make_zero",
            "-y",
            output,
        ])
        .output()
        .await
        .map_err(|e| format!("failed to run ffmpeg: {e}"))?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(format!("ffmpeg exited with an error: {}", stderr.trim()));
    }

    Ok(())
}
