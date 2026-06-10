//! Tauri command handlers. Each returns `Result<T, String>` where the error
//! string is shown to the user, per the project conventions.

use std::path::Path;

use tauri_plugin_shell::ShellExt;

use crate::cutter;
use crate::filmstrip;
use crate::keyframes;
use crate::probe::{self, VideoMeta};

/// Run the bundled `ffprobe` sidecar with `args` and return its stdout.
async fn run_ffprobe(app: &tauri::AppHandle, args: &[&str]) -> Result<String, String> {
    let output = app
        .shell()
        .sidecar("ffprobe")
        .map_err(|e| format!("failed to locate ffprobe sidecar: {e}"))?
        .args(args.iter().copied())
        .output()
        .await
        .map_err(|e| format!("failed to run ffprobe: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffprobe exited with an error: {}", stderr.trim()));
    }

    String::from_utf8(output.stdout)
        .map_err(|e| format!("ffprobe output was not valid UTF-8: {e}"))
}

/// Probe a video file with the bundled `ffprobe` sidecar and return its
/// [`VideoMeta`]. The source is read in place and never modified.
#[tauri::command]
pub async fn probe_video(app: tauri::AppHandle, path: String) -> Result<VideoMeta, String> {
    let json = run_ffprobe(
        &app,
        &[
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
            &path,
        ],
    )
    .await?;

    let ext = Path::new(&path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_lowercase();

    probe::parse_meta(&json, &ext).map_err(|e| e.to_string())
}

/// List the video stream's keyframe timestamps (seconds), sorted ascending,
/// with `0.0` always present. Drives the magnetic IN handle.
#[tauri::command]
pub async fn list_keyframes(app: tauri::AppHandle, path: String) -> Result<Vec<f64>, String> {
    let json = run_ffprobe(
        &app,
        &[
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "packet=pts_time,flags",
            "-of",
            "json",
            &path,
        ],
    )
    .await?;

    keyframes::parse_keyframes(&json).map_err(|e| e.to_string())
}

/// Export the selected range as a lossless clip via `ffmpeg -c copy`.
///
/// `start` is the keyframe-snapped IN time and `duration` is `out - start`.
/// `output`'s extension must equal `input`'s so the stream copy always muxes
/// back into a compatible container. The source is read in place and never
/// modified; the only file written is `output`.
#[tauri::command]
pub async fn export_clip(
    app: tauri::AppHandle,
    input: String,
    output: String,
    start: f64,
    duration: f64,
) -> Result<(), String> {
    cutter::cut(&app, &input, &output, start, duration).await
}

/// Build the timeline preview strip for `path` and return it as a PNG data URI.
/// No file is written to disk; ffmpeg pipes the montage to stdout.
#[tauri::command]
pub async fn generate_filmstrip(
    app: tauri::AppHandle,
    path: String,
    duration_secs: f64,
) -> Result<String, String> {
    filmstrip::generate(&app, &path, duration_secs).await
}
