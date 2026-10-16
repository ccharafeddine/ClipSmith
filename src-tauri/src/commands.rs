//! Tauri command handlers. Each returns `Result<T, String>` where the error
//! string is shown to the user, per the project conventions.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

use crate::cutter;
use crate::encoders::{self, QualityTier, VideoEncoder};
use crate::filmstrip;
use crate::formats::{self, OutputFormat};
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

    String::from_utf8(output.stdout).map_err(|e| format!("ffprobe output was not valid UTF-8: {e}"))
}

/// Reject a path that ffmpeg/ffprobe would parse as an option (leading `-`).
/// Paths come from native dialogs / temp downloads and are normally absolute, so
/// this is a cheap defense-in-depth invariant against argument injection.
fn reject_flaglike(path: &str) -> Result<(), String> {
    if path.starts_with('-') {
        return Err("that file path isn't allowed".to_string());
    }
    Ok(())
}

/// The final path component of `name`, so a suggested save filename can't carry
/// directory separators or `..` that would escape the exports folder.
fn safe_filename(name: &str) -> String {
    Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("clip.mp4")
        .to_string()
}

/// Probe a video file with the bundled `ffprobe` sidecar and return its
/// [`VideoMeta`]. The source is read in place and never modified.
#[tauri::command]
pub async fn probe_video(app: tauri::AppHandle, path: String) -> Result<VideoMeta, String> {
    reject_flaglike(&path)?;
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
    reject_flaglike(&path)?;
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

/// Export the selected range as a frame-accurate H.264/AAC mp4 via a libx264
/// re-encode, optionally reframed into a chosen output canvas.
///
/// Encode options for [`export_clip`], grouped so the command stays within a
/// sane argument count. `reframe` reshapes the frame (blur-fill / pad /
/// crop-to-fill; see [`cutter::Reframe`]) and also carries any resolution
/// downscale as smaller canvas dimensions; `format` is the output
/// container/codecs id (`mp4`/`mov`/`mkv`/`webm`); `use_hardware` picks a
/// detected hardware encoder for the H.264 formats (ignored for WebM); `tier`
/// is the export quality level (defaults to High == v1's CRF 18 / `medium`).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    #[serde(default)]
    pub reframe: Option<cutter::Reframe>,
    pub format: String,
    pub use_hardware: bool,
    #[serde(default)]
    pub tier: QualityTier,
    /// When true, stream-copy instead of re-encoding: instant and bit-identical,
    /// keeping the source container. The frontend only sets this for an identity
    /// cut (no reframe/scale) with `start` snapped to a keyframe, so `reframe`,
    /// `format`, `use_hardware`, `tier`, and the audio options are all ignored on
    /// this path (the copy keeps the source audio verbatim).
    #[serde(default)]
    pub lossless: bool,
    /// Drop the audio from the exported clip.
    #[serde(default)]
    pub mute: bool,
    /// Linear audio gain (`1.0` = unchanged); ignored when muted.
    #[serde(default = "default_volume")]
    pub volume: f32,
}

/// Serde default for [`ExportOptions::volume`]: unity gain (no change).
fn default_volume() -> f32 {
    1.0
}

/// Export the range `[start, start + duration)` of `input` to `output`. `start`
/// is the (free, frame-accurate) IN time and `duration` is `out - start`; see
/// [`ExportOptions`] for the encode settings. The source is read in place and
/// never modified; the only file written is `output`. Emits `export-progress`.
#[tauri::command]
pub async fn export_clip(
    app: tauri::AppHandle,
    input: String,
    output: String,
    start: f64,
    duration: f64,
    options: ExportOptions,
) -> Result<(), String> {
    reject_flaglike(&input)?;
    reject_flaglike(&output)?;

    // Lossless fast-path: a plain stream copy, no re-encode. Skips the whole
    // codec/reframe pipeline (which doesn't apply to a copy).
    if options.lossless {
        return cutter::copy(&app, &input, &output, start, duration).await;
    }

    let fmt = OutputFormat::from_id(&options.format).unwrap_or(OutputFormat::Mp4);
    // Hardware encoding only applies to the H.264 formats; WebM is always VP9.
    let encoder = if fmt.uses_h264() && options.use_hardware {
        encoders::detect_cached(&app).await
    } else {
        VideoEncoder::X264
    };
    let encoding = cutter::Encoding {
        format: fmt,
        encoder,
        tier: options.tier,
        audio: cutter::Audio {
            mute: options.mute,
            volume: options.volume,
        },
    };
    cutter::cut(
        &app,
        &input,
        &output,
        start,
        duration,
        options.reframe,
        encoding,
    )
    .await
}

/// The output formats the bundled ffmpeg can produce, as their ids
/// (`["mp4","mov","mkv"]`, plus `"webm"` when VP9/Opus is available). Detected
/// once and cached for the session. The frontend renders a chip per id.
#[tauri::command]
pub async fn available_formats(app: tauri::AppHandle) -> Vec<String> {
    formats::available_cached(&app)
        .await
        .iter()
        .map(|f| f.id().to_string())
        .collect()
}

/// The best available H.264 encoder's user-facing name (detecting once and
/// caching for the session). The frontend shows this so the user knows whether
/// hardware acceleration is active. Detection never fails — it falls back to
/// libx264 — so this always returns a name.
#[tauri::command]
pub async fn detect_encoder(app: tauri::AppHandle) -> String {
    encoders::detect_cached(&app)
        .await
        .display_name()
        .to_string()
}

/// Resolve ClipSmith's default exports folder. Does not create it: callers that
/// need it on disk (e.g. `default_save_path`) create it themselves.
///
/// In dev builds this is the project's own `Exports/` folder (so exports land
/// next to the source tree while developing). Release builds use
/// `<Documents>/ClipSmith/Exports`. Mirrors GifSmith's behavior so the two
/// sibling apps stay consistent.
fn exports_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // CARGO_MANIFEST_DIR is baked in at compile time as `<project>/src-tauri`;
    // its parent is the project root. Gated on debug_assertions so shipped
    // builds never reference a path that won't exist on the user's machine.
    if cfg!(debug_assertions) {
        if let Some(root) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
            return Ok(root.join("Exports"));
        }
    }
    let docs = app
        .path()
        .document_dir()
        .map_err(|e| format!("could not find your Documents folder: {e}"))?;
    Ok(docs.join("ClipSmith").join("Exports"))
}

/// Resolve the default save path `<exports_dir>/<filename>`, creating the
/// exports folder on demand. The frontend uses this to point the save dialog at
/// the Exports folder; on error it falls back to a bare filename.
///
/// # Errors
/// Returns a user-facing message if the folder can't be resolved or created.
#[tauri::command]
pub fn default_save_path(app: tauri::AppHandle, filename: String) -> Result<String, String> {
    let dir = exports_dir(&app)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create the export folder: {e}"))?;
    // Sanitize: only the final component, so an absolute or `..`-laden name can't
    // point the suggested save path outside the exports folder.
    Ok(dir
        .join(safe_filename(&filename))
        .to_string_lossy()
        .into_owned())
}

/// Build the timeline preview strip for `path` and return it as a PNG data URI.
/// No file is written to disk; ffmpeg pipes the montage to stdout.
#[tauri::command]
pub async fn generate_filmstrip(
    app: tauri::AppHandle,
    path: String,
    duration_secs: f64,
    count: u32,
) -> Result<String, String> {
    reject_flaglike(&path)?;
    filmstrip::generate(&app, &path, duration_secs, count).await
}

// ---- URL import -----------------------------------------------------------
//
// ClipSmith reads sources in place and writes nothing but the final clip. The
// one exception is opening a remote URL: it's downloaded to an OS temp file via
// the bundled `yt-dlp` sidecar (or a plain HTTP GET for direct file links),
// then treated as an ordinary local source. The temp file is deleted on app
// exit (see `cleanup_temp`). This is the only feature that touches the network.

/// Temp dir for URL downloads. Reused across imports and wiped on app exit.
pub fn download_dir() -> PathBuf {
    std::env::temp_dir().join("clipsmith-dl")
}

/// Remove any leftover playback-proxy files (uniquely named, so glob by prefix).
fn remove_proxy_files() {
    if let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("clipsmith-proxy") && name.ends_with(".mp4") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// Best-effort removal of all temp files ClipSmith may have written. Call on exit.
pub fn cleanup_temp() {
    let _ = std::fs::remove_dir_all(download_dir());
    remove_proxy_files();
}

/// Transcode a lightweight H.264 proxy for codecs the webview can't decode
/// (e.g. MPEG-4 ASP in `.avi`, HEVC, ProRes). Playback uses this proxy; the
/// export still stream-copies the original, so the cut stays lossless and no
/// encoder ever touches the exported clip. Audio is kept so the preview has
/// sound. Returns the proxy file path.
///
/// The proxy encoder is platform-specific and LGPL-clean (never GPL libx264):
/// macOS uses the hardware `h264_videotoolbox` (a system framework); Windows
/// uses `libopenh264` from the bundled LGPL build.
///
/// # Errors
/// Returns a user-facing message if ffmpeg can't be located or transcoding fails.
#[tauri::command]
pub async fn generate_proxy(app: AppHandle, path: String) -> Result<String, String> {
    reject_flaglike(&path)?;
    remove_proxy_files();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let out = std::env::temp_dir().join(format!("clipsmith-proxy-{nanos}.mp4"));
    let out_str = out.to_string_lossy().into_owned();

    #[cfg(target_os = "macos")]
    let vcodec = "h264_videotoolbox";
    #[cfg(not(target_os = "macos"))]
    let vcodec = "libopenh264";

    let output = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("could not locate ffmpeg: {e}"))?
        .args([
            "-y",
            "-v",
            "error",
            "-i",
            &path,
            // Don't upscale; cap width at 1280 for a crisp-enough trim preview.
            "-vf",
            "scale='min(1280,iw)':-2",
            "-c:v",
            vcodec,
            "-b:v",
            "4000k",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-movflags",
            "+faststart",
            &out_str,
        ])
        .output()
        .await
        .map_err(|e| format!("ffmpeg failed to start: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("could not build preview: {}", stderr.trim()));
    }
    Ok(out_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_filename_keeps_only_the_final_component() {
        assert_eq!(safe_filename("clip.mp4"), "clip.mp4");
        assert_eq!(safe_filename("../../etc/evil"), "evil");
        assert_eq!(safe_filename("/abs/path/x.webm"), "x.webm");
        assert_eq!(safe_filename(""), "clip.mp4");
        assert_eq!(safe_filename("../"), "clip.mp4");
    }

    #[test]
    fn flaglike_paths_are_rejected() {
        assert!(reject_flaglike("-rf").is_err());
        assert!(reject_flaglike("--output=/tmp/x").is_err());
        assert!(reject_flaglike("/home/u/clip.mp4").is_ok());
        assert!(reject_flaglike("C:/videos/clip.mp4").is_ok());
    }
}
