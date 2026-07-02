//! Tauri command handlers. Each returns `Result<T, String>` where the error
//! string is shown to the user, per the project conventions.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::cutter;
use crate::encoders::{self, VideoEncoder};
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

/// Whether `url` is an http/https URL — the only schemes ClipSmith will fetch.
/// Blocks `file://`, `--flag`-shaped strings, and anything else before it reaches
/// yt-dlp (which would otherwise treat a non-URL as a CLI option).
fn is_http_url(url: &str) -> bool {
    reqwest::Url::parse(url)
        .map(|u| matches!(u.scheme(), "http" | "https"))
        .unwrap_or(false)
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

/// Sanity ceiling for a URL download (direct fetch and yt-dlp): a runaway guard
/// against filling the disk, set well above any normal source video.
const MAX_DOWNLOAD_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_DOWNLOAD_YTDLP: &str = "16G";

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
/// crop-to-fill; see [`cutter::Reframe`]); `format` is the output
/// container/codecs id (`mp4`/`mov`/`mkv`/`webm`); `use_hardware` picks a
/// detected hardware encoder for the H.264 formats (ignored for WebM).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    #[serde(default)]
    pub reframe: Option<cutter::Reframe>,
    pub format: String,
    pub use_hardware: bool,
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
fn download_dir() -> PathBuf {
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

/// User-facing message returned when a download is cancelled. The frontend
/// matches on this to swallow the error instead of showing it.
const DOWNLOAD_CANCELLED: &str = "Download cancelled.";

/// Shared flag the running URL download polls so the frontend can cancel it.
#[derive(Default)]
pub struct DownloadCancel(pub Arc<AtomicBool>);

/// Request the in-progress URL download to abort.
#[tauri::command]
pub fn cancel_download(cancel: State<'_, DownloadCancel>) {
    cancel.0.store(true, Ordering::SeqCst);
}

/// Resolve once `flag` is set. Used to race a download await against a cancel
/// request so a stalled fetch (no bytes, no events) can still be aborted.
async fn cancelled(flag: &AtomicBool) {
    while !flag.load(Ordering::SeqCst) {
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
    }
}

/// Parse a yt-dlp progress line like "[download]  12.3% of ..." into 0.0-1.0.
fn parse_download_percent(line: &str) -> Option<f64> {
    let idx = line.find('%')?;
    let prefix = &line[..idx];
    let start = prefix.rfind(char::is_whitespace).map_or(0, |i| i + 1);
    prefix[start..]
        .trim()
        .parse::<f64>()
        .ok()
        .map(|p| (p / 100.0).clamp(0.0, 1.0))
}

/// Extensions ClipSmith treats as a direct video-file link (mirrors the
/// frontend allowlist in state.ts / DropZone.tsx).
const VIDEO_EXTENSIONS: [&str; 6] = ["mp4", "mov", "mkv", "webm", "avi", "m4v"];

/// Classify a URL as a direct media link: if its path component ends in a known
/// video extension (query string ignored), return that lowercased extension.
/// Such links are fetched over plain HTTP rather than routed through yt-dlp.
fn direct_media_extension(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let ext = Path::new(parsed.path())
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)?;
    VIDEO_EXTENSIONS.contains(&ext.as_str()).then_some(ext)
}

/// Resolve the bundled `ffmpeg` sidecar. Tauri places it next to the app binary
/// when bundled, and next to the dev binary in `target/` during development.
/// Used to point yt-dlp at our ffmpeg for any remux/merge it needs.
fn ffmpeg_path() -> std::io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let dir = exe.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "current exe has no parent dir",
        )
    })?;
    let name = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    Ok(dir.join(name))
}

/// Map a yt-dlp stderr dump to a clear, user-facing message. Raw stderr is kept
/// only as a one-line fallback for failures we don't specifically recognize.
fn friendly_ytdlp_error(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    if lower.contains("unsupported url") {
        "This site isn't supported. Try downloading the video yourself and opening the file, or paste a direct link to a video file.".to_string()
    } else if lower.contains("unable to download webpage")
        || lower.contains("failed to resolve")
        || lower.contains("getaddrinfo")
        || lower.contains("connection")
        || lower.contains("timed out")
        || lower.contains("network is unreachable")
        || lower.contains("http error")
    {
        "Couldn't reach that link. Check the URL and your connection.".to_string()
    } else {
        let summary = stderr
            .lines()
            .map(str::trim)
            .rfind(|l| !l.is_empty())
            .unwrap_or("");
        if summary.is_empty() {
            "Download failed.".to_string()
        } else {
            format!("Download failed: {summary}")
        }
    }
}

/// Stream a direct media link to `download_dir()/source.<ext>` over plain HTTP.
/// Reuses the download dir so app-close cleanup already covers it. Emits
/// "download-progress" from Content-Length when present; with no Content-Length
/// it stays silent rather than emitting a fake value.
async fn download_direct(
    app: &AppHandle,
    url: &str,
    ext: &str,
    cancel: &AtomicBool,
) -> Result<String, String> {
    use std::io::Write;

    let dir = download_dir();
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not prepare download folder: {e}"))?;
    let out = dir.join(format!("source.{ext}"));

    let mut resp = reqwest::get(url)
        .await
        .map_err(|_| "Couldn't reach that link. Check the URL and your connection.".to_string())?;
    if !resp.status().is_success() {
        return Err(format!(
            "the server returned {} for that link",
            resp.status()
        ));
    }

    let total = resp.content_length();
    let mut downloaded: u64 = 0;
    let mut file =
        std::fs::File::create(&out).map_err(|e| format!("could not save the download: {e}"))?;
    // Race each chunk read against the cancel flag so even a stalled connection
    // (bytes never arrive) aborts promptly instead of hanging.
    loop {
        let chunk = tokio::select! {
            biased;
            () = cancelled(cancel) => {
                drop(file);
                let _ = std::fs::remove_dir_all(&dir);
                return Err(DOWNLOAD_CANCELLED.to_string());
            }
            chunk = resp.chunk() => chunk
                .map_err(|_| "the download was interrupted before it finished".to_string())?,
        };
        let Some(chunk) = chunk else { break };
        file.write_all(&chunk)
            .map_err(|e| format!("could not write the download: {e}"))?;
        downloaded += chunk.len() as u64;
        if downloaded > MAX_DOWNLOAD_BYTES {
            drop(file);
            let _ = std::fs::remove_dir_all(&dir);
            return Err("that download is too large".to_string());
        }
        if let Some(total) = total.filter(|t| *t > 0) {
            let p = (downloaded as f64 / total as f64).clamp(0.0, 1.0);
            let _ = app.emit("download-progress", p);
        }
    }

    Ok(out.to_string_lossy().into_owned())
}

/// Download a video from a URL and return its local path. Direct links to a
/// video file are fetched over plain HTTP; everything else goes through the
/// bundled `yt-dlp` sidecar. Emits "download-progress" events (0.0-1.0). The
/// resulting file is treated as an ordinary local source and deleted on exit.
///
/// # Errors
/// Returns a user-facing message if the download can't start, fails, or
/// produces no file.
#[tauri::command]
pub async fn download_video(
    app: AppHandle,
    cancel: State<'_, DownloadCancel>,
    url: String,
) -> Result<String, String> {
    let flag = cancel.0.clone();
    flag.store(false, Ordering::SeqCst);

    // Only http/https. Blocks file:// and, crucially, `--flag`-shaped strings
    // that yt-dlp would otherwise parse as options rather than a URL.
    if !is_http_url(&url) {
        return Err("Only http and https links are supported.".to_string());
    }

    // Direct file links skip yt-dlp entirely: a plain streaming GET is faster and
    // works even for hosts yt-dlp has no extractor for.
    if let Some(ext) = direct_media_extension(&url) {
        return download_direct(&app, &url, &ext, &flag).await;
    }

    let dir = download_dir();
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not prepare download folder: {e}"))?;
    let template = dir.join("source.%(ext)s");

    let mut args: Vec<String> = vec![
        // Ignore any user/global yt-dlp config so a planted config file can't
        // inject options (e.g. --exec); cap the size as a runaway disk guard.
        "--ignore-config".into(),
        "--max-filesize".into(),
        MAX_DOWNLOAD_YTDLP.into(),
        "--no-playlist".into(),
        "--no-part".into(),
        "--newline".into(),
        "-f".into(),
        // Prefer an H.264 mp4 the webview can play; fall back to anything.
        "bestvideo[height<=1080][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/best[ext=mp4]/best"
            .into(),
        "-o".into(),
        template.to_string_lossy().into_owned(),
    ];
    // Let yt-dlp use our ffmpeg for any remux/merge it needs.
    if let Some(dir) = ffmpeg_path()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from))
    {
        args.push("--ffmpeg-location".into());
        args.push(dir.to_string_lossy().into_owned());
    }
    // End-of-options: everything after `--` is a positional URL, never a flag.
    args.push("--".into());
    args.push(url);

    // MAINTAINER NOTE: the bundled yt-dlp goes stale as sites change their
    // players; refresh it (scripts/fetch-ytdlp.sh) on every release build or URL
    // extraction will start failing in the wild.
    let (mut rx, child) = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| format!("could not locate yt-dlp: {e}"))?
        .args(args)
        .spawn()
        .map_err(|e| format!("yt-dlp failed to start: {e}"))?;

    let mut errors = String::new();
    loop {
        // Race the next yt-dlp event against the cancel flag. recv() blocks while
        // yt-dlp is stalled, so polling the flag inside the loop alone wouldn't
        // cancel a hang; select! lets the cancel branch fire regardless.
        let event = tokio::select! {
            biased;
            () = cancelled(&flag) => {
                let _ = child.kill();
                let _ = std::fs::remove_dir_all(&dir);
                return Err(DOWNLOAD_CANCELLED.to_string());
            }
            event = rx.recv() => match event {
                Some(event) => event,
                None => break,
            },
        };
        match event {
            CommandEvent::Stdout(bytes) => {
                if let Some(p) = parse_download_percent(&String::from_utf8_lossy(&bytes)) {
                    let _ = app.emit("download-progress", p);
                }
            }
            CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                if let Some(p) = parse_download_percent(&line) {
                    let _ = app.emit("download-progress", p);
                } else {
                    errors.push_str(&line);
                }
            }
            CommandEvent::Error(e) => errors.push_str(&e),
            CommandEvent::Terminated(payload) if payload.code != Some(0) => {
                return Err(friendly_ytdlp_error(&errors));
            }
            _ => {}
        }
    }

    let file = std::fs::read_dir(&dir)
        .map_err(|e| format!("could not read download folder: {e}"))?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| p.is_file());
    match file {
        Some(p) => Ok(p.to_string_lossy().into_owned()),
        None => Err("the download produced no file".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_http_and_https_urls_pass() {
        assert!(is_http_url("https://example.com/v.mp4"));
        assert!(is_http_url("http://host/path?q=1"));
        // Blocked: other schemes, flag-shaped strings, and non-URLs.
        assert!(!is_http_url("file:///etc/passwd"));
        assert!(!is_http_url("ftp://host/x"));
        assert!(!is_http_url("--config-location=/tmp/x"));
        assert!(!is_http_url("just some text"));
    }

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

    #[test]
    fn direct_media_extension_classifies_links() {
        assert_eq!(
            direct_media_extension("https://h/x.MP4"),
            Some("mp4".to_string())
        );
        assert_eq!(
            direct_media_extension("https://h/a/b.webm?t=1"),
            Some("webm".to_string())
        );
        assert_eq!(
            direct_media_extension("https://youtube.com/watch?v=x"),
            None
        );
    }
}
