//! Tauri command handlers. Each returns `Result<T, String>` where the error
//! string is shown to the user, per the project conventions.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::cutter;
use crate::encoders::{self, QualityTier, VideoEncoder};
use crate::filmstrip;
use crate::formats::{self, OutputFormat};
use crate::keyframes;
use crate::probe::{self, VideoMeta};
use crate::scrape::{self, MediaKind};

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
        UNSUPPORTED_SITE.to_string()
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

/// User-facing message for a page neither yt-dlp nor the fallback scraper could
/// find a video on.
const UNSUPPORTED_SITE: &str = "This site isn't supported. Try downloading the video yourself and opening the file, or paste a direct link to a video file.";

/// True when yt-dlp failed because it has no extractor for the page (or its
/// generic extractor found nothing): the cue to try the HTML scraper fallback.
/// Network/HTTP failures are deliberately excluded - scraping won't fix those.
fn ytdlp_unsupported(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("unsupported url") || lower.contains("no video formats found")
}

/// Browser-like UA for the scrape fallback: many sites serve a stripped page
/// (or a 403) to non-browser clients.
const SCRAPE_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/// Cap on how much page HTML the scrape fallback reads.
const MAX_SCRAPE_HTML_BYTES: usize = 5 * 1024 * 1024;

/// Cap on an HLS master playlist read (they're a few KB in practice).
const MAX_PLAYLIST_BYTES: usize = 2 * 1024 * 1024;

/// Most media candidates the scrape fallback will try per page.
const MAX_SCRAPE_ATTEMPTS: usize = 3;

/// Most embedded players (iframes / embed URLs) the fallback will follow. Each
/// gets one yt-dlp attempt and one scrape of the embed page (depth 2 max; the
/// embed page's own iframes are not followed), which bounds total time.
const MAX_EMBEDS: usize = 3;

/// Protocols ffmpeg may open for a scraped stream: network only, so a crafted
/// playlist can't make it read local files (`file:`) or spawn anything.
const STREAM_PROTOCOLS: &str = "http,https,tcp,tls,crypto";

/// yt-dlp format selection, source quality with no resolution cap or codec
/// preference: the best video-only stream + best audio (merged), else the best
/// single file that already has audio, else any video + audio. Video-only first
/// avoids merging a muxed file with a second copy of its own audio (`bv*+ba`
/// produced two audio tracks on single-file sites).
const YTDLP_FORMAT: &str = "bv*[acodec=none]+ba/b/bv*+ba";

/// yt-dlp format sort: highest resolution, then frame rate, then bitrate.
const YTDLP_SORT: &str = "res,fps,br";

/// Merge container: mp4 when the codecs fit (H.264/AAC, and modern VP9/AV1/Opus
/// too), mkv otherwise - so no format is ever downgraded to fit a container.
const YTDLP_MERGE: &str = "mp4/mkv";

/// Build the yt-dlp argument list. `referer` is sent for embed URLs (many
/// players are domain-locked to the page that embeds them).
fn ytdlp_args(
    template: &str,
    ffmpeg_location: Option<&str>,
    referer: Option<&str>,
    url: &str,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        // Ignore any user/global yt-dlp config so a planted config file can't
        // inject options (e.g. --exec); cap the size as a runaway disk guard.
        "--ignore-config".into(),
        "--max-filesize".into(),
        MAX_DOWNLOAD_YTDLP.into(),
        "--no-playlist".into(),
        "--no-part".into(),
        "--newline".into(),
        "--socket-timeout".into(),
        "20".into(),
        "-f".into(),
        YTDLP_FORMAT.into(),
        "-S".into(),
        YTDLP_SORT.into(),
        "--merge-output-format".into(),
        YTDLP_MERGE.into(),
        "-o".into(),
        template.into(),
    ];
    if let Some(loc) = ffmpeg_location {
        // Let yt-dlp use our ffmpeg for any remux/merge it needs.
        args.push("--ffmpeg-location".into());
        args.push(loc.into());
    }
    if let Some(r) = referer.filter(|r| is_http_url(r)) {
        args.push("--referer".into());
        args.push(r.into());
    }
    // End-of-options: everything after `--` is a positional URL, never a flag.
    args.push("--".into());
    args.push(url.into());
    args
}

/// `scheme://host[:port]` of a URL, for an `Origin` header.
fn origin_of(url: &str) -> Option<String> {
    let u = reqwest::Url::parse(url).ok()?;
    let origin = u.origin().ascii_serialization();
    (origin != "null").then_some(origin)
}

/// HTTP client for scraped fetches: browser UA, plus Referer/Origin of the page
/// the media was found on (hosts commonly reject hotlinks without them).
fn scrape_client(referer: Option<&str>, timeout: Option<u64>) -> Result<reqwest::Client, String> {
    let mut headers = reqwest::header::HeaderMap::new();
    if let Some(r) = referer {
        if let Ok(v) = reqwest::header::HeaderValue::from_str(r) {
            headers.insert(reqwest::header::REFERER, v);
        }
        if let Some(o) = origin_of(r).and_then(|o| reqwest::header::HeaderValue::from_str(&o).ok())
        {
            headers.insert(reqwest::header::ORIGIN, o);
        }
    }
    let mut b = reqwest::Client::builder()
        .user_agent(SCRAPE_USER_AGENT)
        .default_headers(headers)
        .connect_timeout(std::time::Duration::from_secs(20));
    if let Some(t) = timeout {
        b = b.timeout(std::time::Duration::from_secs(t));
    }
    b.build()
        .map_err(|e| format!("could not start the page fetch: {e}"))
}

/// Parse ffmpeg's input `Duration: HH:MM:SS.xx,` header into seconds. Live
/// streams report `N/A`, which yields `None` (no progress is emitted then).
fn parse_ffmpeg_duration(s: &str) -> Option<f64> {
    let idx = s.find("Duration:")?;
    let rest = s[idx + "Duration:".len()..].trim_start();
    let field = rest.split([',', ' ', '\n', '\r']).next()?;
    let mut parts = field.split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let sec: f64 = parts.next()?.parse().ok()?;
    let total = h * 3600.0 + m * 60.0 + sec;
    (total > 0.0).then_some(total)
}

/// Fetch a page/playlist as text: browser UA (+ Referer/Origin), 20s timeout,
/// and a size cap (excess is truncated, not an error - a partial page still
/// parses). Races the read against the cancel flag.
async fn fetch_text(
    url: &str,
    referer: Option<&str>,
    cap: usize,
    cancel: &AtomicBool,
) -> Result<String, String> {
    let client = scrape_client(referer, Some(20))?;
    let mut resp = tokio::select! {
        biased;
        () = cancelled(cancel) => return Err(DOWNLOAD_CANCELLED.to_string()),
        r = client.get(url).header("Accept", "text/html,application/xhtml+xml,*/*;q=0.8").send() => r
            .map_err(|_| "Couldn't reach that link. Check the URL and your connection.".to_string())?,
    };
    if !resp.status().is_success() {
        return Err(UNSUPPORTED_SITE.to_string());
    }
    let mut body: Vec<u8> = Vec::new();
    loop {
        let chunk = tokio::select! {
            biased;
            () = cancelled(cancel) => return Err(DOWNLOAD_CANCELLED.to_string()),
            c = resp.chunk() => c.map_err(|_| UNSUPPORTED_SITE.to_string())?,
        };
        let Some(chunk) = chunk else { break };
        body.extend_from_slice(&chunk);
        if body.len() >= cap {
            body.truncate(cap);
            break;
        }
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

/// What ffmpeg should read for a stream candidate.
#[derive(Debug, PartialEq)]
struct StreamInputs {
    /// One input (a manifest or a chosen variant) or two (variant + audio).
    inputs: Vec<String>,
    /// True when `inputs[0]` is an already-chosen single variant.
    pinned: bool,
}

/// For an HLS master playlist, pick the best variant (highest resolution, then
/// bandwidth) and its matching audio rendition. DASH / unknown streams are
/// passed through whole: with no `-map`, ffmpeg's default stream selection
/// already takes the highest-resolution video and the best audio. Any playlist
/// fetch/parse failure falls back to handing ffmpeg the URL as-is.
async fn resolve_stream_inputs(
    url: &str,
    kind: &MediaKind,
    referer: Option<&str>,
    cancel: &AtomicBool,
) -> Result<StreamInputs, String> {
    if *kind == MediaKind::Hls {
        match fetch_text(url, referer, MAX_PLAYLIST_BYTES, cancel).await {
            Ok(text) => {
                if let Some(c) = scrape::best_hls_variant(&text, url) {
                    let mut inputs = vec![c.video];
                    inputs.extend(c.audio);
                    return Ok(StreamInputs {
                        inputs,
                        pinned: true,
                    });
                }
            }
            Err(e) if e == DOWNLOAD_CANCELLED => return Err(e),
            Err(_) => {}
        }
    }
    Ok(StreamInputs {
        inputs: vec![url.to_string()],
        pinned: false,
    })
}

/// Build the ffmpeg remux command for a stream: per-input network-only protocol
/// whitelist + browser UA + Referer/Origin, stream copy (no re-encode, so the
/// source quality is untouched), size cap, and `+faststart`. `max_secs` limits
/// the output duration (used only by the live test harness).
fn stream_args(
    s: &StreamInputs,
    referer: Option<&str>,
    out: &str,
    max_secs: Option<f64>,
) -> Vec<String> {
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-nostdin".into(), "-y".into()];
    for input in &s.inputs {
        args.extend([
            "-protocol_whitelist".to_string(),
            STREAM_PROTOCOLS.to_string(),
            "-user_agent".to_string(),
            SCRAPE_USER_AGENT.to_string(),
        ]);
        if let Some(r) = referer.filter(|r| is_http_url(r)) {
            args.extend(["-referer".to_string(), r.to_string()]);
            if let Some(o) = origin_of(r) {
                args.extend(["-headers".to_string(), format!("Origin: {o}\r\n")]);
            }
        }
        args.extend(["-i".to_string(), input.clone()]);
    }
    if s.inputs.len() > 1 {
        args.extend(["-map", "0:v:0", "-map", "1:a:0"].map(String::from));
    } else if s.pinned {
        args.extend(["-map", "0:v:0", "-map", "0:a:0?"].map(String::from));
    }
    args.extend(["-c".to_string(), "copy".to_string()]);
    if let Some(t) = max_secs {
        args.extend(["-t".to_string(), format!("{t}")]);
    }
    args.extend([
        "-fs".to_string(),
        MAX_DOWNLOAD_BYTES.to_string(),
        "-movflags".to_string(),
        "+faststart".to_string(),
        out.to_string(),
    ]);
    args
}

/// Wipe and recreate the download folder.
fn fresh_download_dir() -> Result<PathBuf, String> {
    let dir = download_dir();
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not prepare download folder: {e}"))?;
    Ok(dir)
}

/// Remux a stream candidate to `download_dir()/source.mp4` with the bundled
/// ffmpeg (see `resolve_stream_inputs` / `stream_args`). Honours the cancel
/// flag, emits "download-progress" when the input reports a finite duration,
/// and removes the partial file on any failure.
async fn download_stream(
    app: &AppHandle,
    stream_url: &str,
    kind: &MediaKind,
    referer: Option<&str>,
    cancel: &AtomicBool,
) -> Result<String, String> {
    // Defence in depth: the scraper already keeps http/https only, and an
    // http(s) URL can never start with `-`, so it can't be read as an option.
    if !is_http_url(stream_url) {
        return Err(UNSUPPORTED_SITE.to_string());
    }
    let inputs = resolve_stream_inputs(stream_url, kind, referer, cancel).await?;
    if inputs.inputs.iter().any(|i| !is_http_url(i)) {
        return Err(UNSUPPORTED_SITE.to_string());
    }
    let out = fresh_download_dir()?.join("source.mp4");
    let out_s = out.to_string_lossy().into_owned();
    let args = stream_args(&inputs, referer, &out_s, None);

    let (mut rx, child) = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("could not locate ffmpeg: {e}"))?
        .args(args)
        .spawn()
        .map_err(|e| format!("ffmpeg failed to start: {e}"))?;

    let mut duration: Option<f64> = None;
    let mut tail = String::new();
    let fail = |msg: String| {
        let _ = std::fs::remove_dir_all(download_dir());
        Err(msg)
    };
    loop {
        let event = tokio::select! {
            biased;
            () = cancelled(cancel) => {
                let _ = child.kill();
                return fail(DOWNLOAD_CANCELLED.to_string());
            }
            event = rx.recv() => match event {
                Some(event) => event,
                None => break,
            },
        };
        match event {
            CommandEvent::Stderr(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                if duration.is_none() {
                    duration = parse_ffmpeg_duration(&text);
                }
                if let (Some(total), Some(t)) = (duration, cutter::parse_progress_time(&text)) {
                    let _ = app.emit("download-progress", (t / total).clamp(0.0, 1.0));
                }
                tail.push_str(&text);
                if tail.len() > 4096 {
                    let cut = tail.len() - 4096;
                    let cut = (cut..tail.len())
                        .find(|i| tail.is_char_boundary(*i))
                        .unwrap_or(0);
                    tail.drain(..cut);
                }
            }
            CommandEvent::Error(e) => tail.push_str(&e),
            CommandEvent::Terminated(payload) if payload.code != Some(0) => {
                let summary = tail
                    .lines()
                    .map(str::trim)
                    .rfind(|l| !l.is_empty())
                    .unwrap_or("");
                return fail(if summary.is_empty() {
                    "Download failed.".to_string()
                } else {
                    format!("Download failed: {summary}")
                });
            }
            _ => {}
        }
    }

    match std::fs::metadata(&out) {
        Ok(m) if m.len() > 0 => Ok(out_s),
        _ => fail("the download produced no file".to_string()),
    }
}

/// Why a yt-dlp run didn't produce a file.
enum YtdlpError {
    Cancelled,
    /// yt-dlp failed; carries its stderr.
    Failed(String),
}

/// Run the bundled yt-dlp with `args` (which write into `dir`), forwarding
/// progress, racing the cancel flag, and returning the downloaded file path.
async fn run_ytdlp(
    app: &AppHandle,
    args: Vec<String>,
    dir: &Path,
    cancel: &AtomicBool,
) -> Result<String, YtdlpError> {
    // MAINTAINER NOTE: the bundled yt-dlp goes stale as sites change their
    // players; refresh it (scripts/fetch-ytdlp.sh) on every release build or URL
    // extraction will start failing in the wild.
    let (mut rx, child) = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| YtdlpError::Failed(format!("could not locate yt-dlp: {e}")))?
        .args(args)
        .spawn()
        .map_err(|e| YtdlpError::Failed(format!("yt-dlp failed to start: {e}")))?;

    let mut errors = String::new();
    loop {
        // Race the next yt-dlp event against the cancel flag. recv() blocks while
        // yt-dlp is stalled, so polling the flag inside the loop alone wouldn't
        // cancel a hang; select! lets the cancel branch fire regardless.
        let event = tokio::select! {
            biased;
            () = cancelled(cancel) => {
                let _ = child.kill();
                let _ = std::fs::remove_dir_all(dir);
                return Err(YtdlpError::Cancelled);
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
                return Err(YtdlpError::Failed(errors));
            }
            _ => {}
        }
    }

    std::fs::read_dir(dir)
        .map_err(|e| YtdlpError::Failed(format!("could not read download folder: {e}")))?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| YtdlpError::Failed("the download produced no file".to_string()))
}

/// The `--ffmpeg-location` to hand yt-dlp (the folder holding our sidecar).
fn ytdlp_ffmpeg_location() -> Option<String> {
    ffmpeg_path()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_string_lossy().into_owned()))
}

/// Try a page's media candidates (best first, up to `MAX_SCRAPE_ATTEMPTS`):
/// direct files over HTTP, streams through ffmpeg, all with `referer` as the
/// Referer/Origin. `Ok(None)` = nothing worked (reason left in `last_err`);
/// `Err` only for a cancel.
async fn try_media(
    app: &AppHandle,
    candidates: &[scrape::Candidate],
    referer: &str,
    cancel: &AtomicBool,
    last_err: &mut String,
) -> Result<Option<String>, String> {
    let media = candidates.iter().filter(|c| c.kind != MediaKind::Embed);
    for c in media.take(MAX_SCRAPE_ATTEMPTS) {
        let result = match &c.kind {
            MediaKind::File(ext) => download_direct(app, &c.url, ext, Some(referer), cancel).await,
            kind => download_stream(app, &c.url, kind, Some(referer), cancel).await,
        };
        match result {
            Ok(path) => return Ok(Some(path)),
            Err(e) if e == DOWNLOAD_CANCELLED => return Err(e),
            Err(e) => *last_err = e,
        }
    }
    Ok(None)
}

/// Fallback for pages yt-dlp has no extractor for. Order (each step bounded):
/// 1. fetch the page HTML and try its embedded media (video tags, data-attrs,
///    JSON-LD, script/packed-JS URLs), best quality first;
/// 2. for each embedded player (iframe / embed URL, up to `MAX_EMBEDS`): run
///    yt-dlp on the embed URL with the page as Referer (Vimeo, YouTube,
///    Dailymotion, JW Player, Brightcove, Wistia, Streamable, ... embeds), and
///    if that fails, scrape the embed page's own media once.
///
/// With nothing found it returns the original "site isn't supported" message.
async fn scrape_fallback(
    app: &AppHandle,
    page_url: &str,
    cancel: &AtomicBool,
) -> Result<String, String> {
    let html = fetch_text(page_url, None, MAX_SCRAPE_HTML_BYTES, cancel).await?;
    let candidates = scrape::extract_candidates(&html, page_url);
    let mut last_err = UNSUPPORTED_SITE.to_string();
    if let Some(p) = try_media(app, &candidates, page_url, cancel, &mut last_err).await? {
        return Ok(p);
    }
    let embeds = candidates.iter().filter(|c| c.kind == MediaKind::Embed);
    for embed in embeds.take(MAX_EMBEDS) {
        let dir = fresh_download_dir()?;
        let template = dir.join("source.%(ext)s").to_string_lossy().into_owned();
        let args = ytdlp_args(
            &template,
            ytdlp_ffmpeg_location().as_deref(),
            Some(page_url),
            &embed.url,
        );
        match run_ytdlp(app, args, &dir, cancel).await {
            Ok(p) => return Ok(p),
            Err(YtdlpError::Cancelled) => return Err(DOWNLOAD_CANCELLED.to_string()),
            Err(YtdlpError::Failed(_)) => {}
        }
        match fetch_text(&embed.url, Some(page_url), MAX_SCRAPE_HTML_BYTES, cancel).await {
            Ok(h) => {
                let inner = scrape::extract_candidates(&h, &embed.url);
                if let Some(p) = try_media(app, &inner, &embed.url, cancel, &mut last_err).await? {
                    return Ok(p);
                }
            }
            Err(e) if e == DOWNLOAD_CANCELLED => return Err(e),
            Err(_) => {}
        }
    }
    Err(last_err)
}

/// Stream `url` into `out` over HTTP (browser UA + Referer/Origin when given),
/// capped at `MAX_DOWNLOAD_BYTES`, racing every chunk against the cancel flag.
/// Calls `on_progress` (0.0-1.0) when Content-Length is known; with no
/// Content-Length it stays silent rather than reporting a fake value.
async fn fetch_to_file(
    url: &str,
    referer: Option<&str>,
    out: &Path,
    cancel: &AtomicBool,
    on_progress: impl Fn(f64),
) -> Result<(), String> {
    use std::io::Write;

    let client = scrape_client(referer, None)?;
    let mut resp = tokio::select! {
        biased;
        () = cancelled(cancel) => return Err(DOWNLOAD_CANCELLED.to_string()),
        r = client.get(url).send() => r
            .map_err(|_| "Couldn't reach that link. Check the URL and your connection.".to_string())?,
    };
    if !resp.status().is_success() {
        return Err(format!(
            "the server returned {} for that link",
            resp.status()
        ));
    }

    let total = resp.content_length();
    let mut downloaded: u64 = 0;
    let mut file =
        std::fs::File::create(out).map_err(|e| format!("could not save the download: {e}"))?;
    loop {
        let chunk = tokio::select! {
            biased;
            () = cancelled(cancel) => return Err(DOWNLOAD_CANCELLED.to_string()),
            chunk = resp.chunk() => chunk
                .map_err(|_| "the download was interrupted before it finished".to_string())?,
        };
        let Some(chunk) = chunk else { break };
        file.write_all(&chunk)
            .map_err(|e| format!("could not write the download: {e}"))?;
        downloaded += chunk.len() as u64;
        if downloaded > MAX_DOWNLOAD_BYTES {
            return Err("that download is too large".to_string());
        }
        if let Some(total) = total.filter(|t| *t > 0) {
            #[allow(clippy::cast_precision_loss)]
            let p = (downloaded as f64 / total as f64).clamp(0.0, 1.0);
            on_progress(p);
        }
    }
    Ok(())
}

/// Download a direct media link to `download_dir()/source.<ext>`. Reuses the
/// download dir so app-close cleanup already covers it; emits
/// "download-progress"; removes the partial file on failure or cancel.
async fn download_direct(
    app: &AppHandle,
    url: &str,
    ext: &str,
    referer: Option<&str>,
    cancel: &AtomicBool,
) -> Result<String, String> {
    let dir = fresh_download_dir()?;
    let out = dir.join(format!("source.{ext}"));
    match fetch_to_file(url, referer, &out, cancel, |p| {
        let _ = app.emit("download-progress", p);
    })
    .await
    {
        Ok(()) => Ok(out.to_string_lossy().into_owned()),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            Err(e)
        }
    }
}

/// Download a video from a URL and return its local path, at source quality.
/// Direct links to a video file are fetched over plain HTTP; everything else
/// goes through the bundled `yt-dlp` sidecar (best video + best audio); if
/// yt-dlp has no extractor for the page, a fallback scrapes the page and its
/// embedded players (see `scrape_fallback`). Emits "download-progress" events
/// (0.0-1.0). The resulting file is treated as an ordinary local source and
/// deleted on exit.
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
        return download_direct(&app, &url, &ext, None, &flag).await;
    }

    let dir = fresh_download_dir()?;
    let template = dir.join("source.%(ext)s").to_string_lossy().into_owned();
    let args = ytdlp_args(&template, ytdlp_ffmpeg_location().as_deref(), None, &url);
    match run_ytdlp(&app, args, &dir, &flag).await {
        Ok(path) => Ok(path),
        Err(YtdlpError::Cancelled) => Err(DOWNLOAD_CANCELLED.to_string()),
        // No extractor for this page: fall back to scraping the HTML (and its
        // embedded players) before giving up.
        Err(YtdlpError::Failed(e)) if ytdlp_unsupported(&e) => {
            scrape_fallback(&app, &url, &flag).await
        }
        Err(YtdlpError::Failed(e)) => Err(friendly_ytdlp_error(&e)),
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
    #[test]
    fn ytdlp_unsupported_detects_fallback_cases() {
        assert!(ytdlp_unsupported(
            "ERROR: Unsupported URL: https://x.example/p"
        ));
        assert!(ytdlp_unsupported(
            "ERROR: [generic] p: No video formats found!; please report this issue"
        ));
        assert!(!ytdlp_unsupported(
            "ERROR: Unable to download webpage: HTTP Error 404"
        ));
        assert!(!ytdlp_unsupported(""));
    }

    #[test]
    fn parses_ffmpeg_duration_header() {
        let s = "Input #0, hls, from 'https://x/i.m3u8':\n  Duration: 00:01:30.50, start: 0.000, bitrate: 0 kb/s";
        assert_eq!(parse_ffmpeg_duration(s), Some(90.5));
        assert_eq!(parse_ffmpeg_duration("  Duration: N/A, start: 0.0"), None);
        assert_eq!(parse_ffmpeg_duration("frame=1 time=00:00:01.00"), None);
    }
    #[test]
    fn ytdlp_args_request_source_quality_safely() {
        let a = ytdlp_args(
            "/tmp/source.%(ext)s",
            Some("/bin"),
            Some("https://page.example/a"),
            "https://v.example/e/1",
        );
        let s = a.join(" ");
        assert!(s.contains("-f bv*[acodec=none]+ba/b/bv*+ba"));
        assert!(s.contains("-S res,fps,br"));
        assert!(s.contains("--merge-output-format mp4/mkv"));
        assert!(!s.contains("height<="));
        assert!(s.contains("--ignore-config"));
        assert!(s.contains("--referer https://page.example/a"));
        // The URL is always last, after the end-of-options separator.
        assert_eq!(&a[a.len() - 2..], ["--", "https://v.example/e/1"]);
        // A non-http referer is never passed through.
        let b = ytdlp_args("t", None, Some("--exec=x"), "https://v.example/");
        assert!(!b.iter().any(|x| x.contains("exec")));
    }

    #[test]
    fn stream_args_map_variant_audio_and_headers() {
        let split = StreamInputs {
            inputs: vec![
                "https://c.example/v1080.m3u8".into(),
                "https://c.example/a.m3u8".into(),
            ],
            pinned: true,
        };
        let a = stream_args(&split, Some("https://page.example/w/1"), "out.mp4", None);
        let s = a.join(" ");
        assert_eq!(a.iter().filter(|x| *x == "-i").count(), 2);
        assert_eq!(a.iter().filter(|x| *x == "-protocol_whitelist").count(), 2);
        assert!(s.contains("http,https,tcp,tls,crypto"));
        assert!(s.contains("-referer https://page.example/w/1"));
        assert!(s.contains("Origin: https://page.example\r\n"));
        assert!(s.contains("-map 0:v:0 -map 1:a:0 -c copy"));
        assert!(!s.contains("-t "));
        assert_eq!(a.last().map(String::as_str), Some("out.mp4"));

        let whole = StreamInputs {
            inputs: vec!["https://c.example/m.mpd".into()],
            pinned: false,
        };
        let b = stream_args(&whole, None, "o.mp4", Some(10.0)).join(" ");
        // No -map: ffmpeg's default picks the highest-resolution video + best audio.
        assert!(!b.contains("-map"));
        assert!(!b.contains("-referer"));
        assert!(b.contains("-c copy -t 10"));

        let pinned = StreamInputs {
            inputs: vec!["https://c.example/v.m3u8".into()],
            pinned: true,
        };
        assert!(stream_args(&pinned, None, "o.mp4", None)
            .join(" ")
            .contains("-map 0:v:0 -map 0:a:0?"));
    }

    #[test]
    fn origin_of_strips_path() {
        assert_eq!(
            origin_of("https://a.example:8443/x/y?z").as_deref(),
            Some("https://a.example:8443")
        );
        assert_eq!(origin_of("not a url"), None);
    }

    /// Live end-to-end harness (network; run explicitly):
    ///   $env:CLIPSMITH_LIVE_URLS="https://a,https://b"; cargo test live_ -- --ignored --nocapture
    /// Mirrors `download_video`'s order using the same building blocks
    /// (`ytdlp_args`, `fetch_text`, `extract_candidates`, `resolve_stream_inputs`,
    /// `stream_args`, `fetch_to_file`), spawning the real bundled binaries from
    /// `binaries/` directly (no AppHandle in a unit test). Output goes to
    /// `$CLIPSMITH_LIVE_OUT/<n>/`; `CLIPSMITH_LIVE_SECS` bounds stream samples.
    #[test]
    #[ignore = "network: live end-to-end harness"]
    fn live_download_harness() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        rt.block_on(live_harness());
    }

    fn bin(name: &str) -> String {
        let triple = if cfg!(windows) {
            "x86_64-pc-windows-msvc.exe"
        } else {
            "x86_64-unknown-linux-gnu"
        };
        format!("{}/binaries/{name}-{triple}", env!("CARGO_MANIFEST_DIR"))
    }

    fn run_ytdlp_bin(args: &[String]) -> Result<(), String> {
        let o = std::process::Command::new(bin("yt-dlp"))
            .args(args)
            .output()
            .map_err(|e| e.to_string())?;
        if o.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&o.stderr).into_owned())
        }
    }

    fn run_ffmpeg_bin(args: &[String]) -> Result<(), String> {
        let o = std::process::Command::new(bin("ffmpeg"))
            .args(args)
            .output()
            .map_err(|e| e.to_string())?;
        if o.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&o.stderr)
                .lines()
                .last()
                .unwrap_or("")
                .to_string())
        }
    }

    fn first_file(dir: &Path) -> Option<String> {
        std::fs::read_dir(dir)
            .ok()?
            .filter_map(Result::ok)
            .map(|e| e.path())
            .find(|p| p.is_file())
            .map(|p| p.to_string_lossy().into_owned())
    }

    async fn harness_media(
        cands: &[scrape::Candidate],
        referer: &str,
        dir: &Path,
        secs: Option<f64>,
    ) -> Option<String> {
        let flag = AtomicBool::new(false);
        for c in cands
            .iter()
            .filter(|c| c.kind != MediaKind::Embed)
            .take(MAX_SCRAPE_ATTEMPTS)
        {
            let r = match &c.kind {
                MediaKind::File(ext) => {
                    let out = dir.join(format!("source.{ext}"));
                    fetch_to_file(&c.url, Some(referer), &out, &flag, |_| {})
                        .await
                        .map(|()| out.to_string_lossy().into_owned())
                }
                kind => {
                    let inputs = resolve_stream_inputs(&c.url, kind, Some(referer), &flag)
                        .await
                        .ok()?;
                    println!("    stream inputs: {:?}", inputs.inputs);
                    let out = dir.join("source.mp4").to_string_lossy().into_owned();
                    run_ffmpeg_bin(&stream_args(&inputs, Some(referer), &out, secs)).map(|()| out)
                }
            };
            match r {
                Ok(p) => return Some(p),
                Err(e) => println!("    candidate failed: {} -> {e}", c.url),
            }
        }
        None
    }

    async fn live_harness() {
        let urls = std::env::var("CLIPSMITH_LIVE_URLS").unwrap_or_default();
        let root = PathBuf::from(std::env::var("CLIPSMITH_LIVE_OUT").unwrap_or_else(|_| {
            std::env::temp_dir()
                .join("clipsmith-live")
                .to_string_lossy()
                .into_owned()
        }));
        let secs: Option<f64> = std::env::var("CLIPSMITH_LIVE_SECS")
            .ok()
            .and_then(|s| s.parse().ok());
        let flag = AtomicBool::new(false);
        for (n, url) in urls
            .split(',')
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .enumerate()
        {
            let dir = root.join(n.to_string());
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("out dir");
            println!("== {url}");
            if let Some(ext) = direct_media_extension(url) {
                let out = dir.join(format!("source.{ext}"));
                let r = fetch_to_file(url, None, &out, &flag, |_| {}).await;
                println!("  direct: {r:?} -> {}", out.display());
                continue;
            }
            let template = dir.join("source.%(ext)s").to_string_lossy().into_owned();
            let mut args = ytdlp_args(&template, Some(&bin("ffmpeg")), None, url);
            if let Some(s) = secs {
                args.splice(0..0, ["--download-sections".to_string(), format!("*0-{s}")]);
            }
            match run_ytdlp_bin(&args) {
                Ok(()) => {
                    println!("  RESULT yt-dlp primary -> {:?}", first_file(&dir));
                    continue;
                }
                Err(e) if ytdlp_unsupported(&e) => {
                    println!("  yt-dlp: unsupported -> scrape fallback")
                }
                Err(e) => {
                    println!(
                        "  RESULT yt-dlp failed (no fallback): {}",
                        friendly_ytdlp_error(&e)
                    );
                    continue;
                }
            }
            let html = match fetch_text(url, None, MAX_SCRAPE_HTML_BYTES, &flag).await {
                Ok(h) => h,
                Err(e) => {
                    println!("  RESULT page fetch failed: {e}");
                    continue;
                }
            };
            let cands = scrape::extract_candidates(&html, url);
            for c in &cands {
                println!("  cand {:?} h={} {}", c.kind, c.height, c.url);
            }
            if let Some(p) = harness_media(&cands, url, &dir, secs).await {
                println!("  RESULT scrape media -> {p}");
                continue;
            }
            let mut done = false;
            for e in cands
                .iter()
                .filter(|c| c.kind == MediaKind::Embed)
                .take(MAX_EMBEDS)
            {
                let mut a = ytdlp_args(&template, Some(&bin("ffmpeg")), Some(url), &e.url);
                if let Some(s) = secs {
                    a.splice(0..0, ["--download-sections".to_string(), format!("*0-{s}")]);
                }
                match run_ytdlp_bin(&a) {
                    Ok(()) => {
                        println!(
                            "  RESULT embed via yt-dlp {} -> {:?}",
                            e.url,
                            first_file(&dir)
                        );
                        done = true;
                        break;
                    }
                    Err(err) => println!(
                        "  embed yt-dlp failed {}: {}",
                        e.url,
                        friendly_ytdlp_error(&err)
                    ),
                }
                if let Ok(h) = fetch_text(&e.url, Some(url), MAX_SCRAPE_HTML_BYTES, &flag).await {
                    let inner = scrape::extract_candidates(&h, &e.url);
                    if let Some(p) = harness_media(&inner, &e.url, &dir, secs).await {
                        println!("  RESULT embed page scrape {} -> {p}", e.url);
                        done = true;
                        break;
                    }
                }
            }
            if !done {
                println!("  RESULT nothing found: {UNSUPPORTED_SITE}");
            }
        }
    }
}
