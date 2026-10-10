// Typed wrappers around the Tauri Rust commands. The frontend never calls
// `invoke` directly; it goes through these so argument and return shapes stay
// in one place.

import { invoke } from "@tauri-apps/api/core";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { Reframe } from "./reframe";

/** Reveal the exported file in the OS file manager (Finder / Explorer). */
export function revealExport(path: string): Promise<void> {
  return revealItemInDir(path);
}

/** Open an external URL (e.g. the release page) in the default browser. */
export function openExternal(url: string): Promise<void> {
  return openUrl(url);
}

/** The result of an update check against GitHub Releases. */
export interface UpdateInfo {
  /** The running version, e.g. "1.0.0". */
  current: string;
  /** The latest published release tag (no leading "v"). */
  latest: string;
  /** Whether `latest` is strictly newer than `current`. */
  isNewer: boolean;
  /** Release notes (GitHub release body); may be empty. */
  notes: string;
  /** The release page URL to open for the download. */
  url: string;
}

/**
 * Ask the backend to check GitHub Releases for a newer ClipSmith. All network
 * access happens in Rust; this just resolves to the comparison. Rejects with a
 * user-facing message on a network / parse failure.
 */
export function checkForUpdate(): Promise<UpdateInfo> {
  return invoke<UpdateInfo>("check_for_update");
}

export interface VideoMeta {
  duration_secs: number;
  width: number;
  height: number;
  fps_num: number;
  fps_den: number;
  codec: string;
  container: string;
}

/** Probe a video file on disk and return its metadata. */
export function probeVideo(path: string): Promise<VideoMeta> {
  return invoke<VideoMeta>("probe_video", { path });
}

/**
 * List the video's keyframe timestamps (seconds), sorted ascending with 0.0
 * always present. Used to snap the magnetic IN handle.
 */
export function listKeyframes(path: string): Promise<number[]> {
  return invoke<number[]>("list_keyframes", { path });
}

/** A crop rectangle in source pixels. Omitted/undefined means no crop. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Encode options for {@link exportClip}, mirroring the backend `ExportOptions`. */
export interface ExportOptions {
  /** Reframe canvas + fill, or `null` for an identity cut. Ignored when lossless. */
  reframe: Reframe | null;
  /** Output format id (`mp4`/`mov`/`mkv`/`webm`). Ignored when lossless. */
  format: string;
  /** Allow a detected hardware H.264 encoder. Ignored when lossless. */
  useHardware: boolean;
  /** Quality tier (`draft`/`balanced`/`high`). Ignored when lossless. */
  tier: string;
  /** Stream-copy instead of re-encoding (see below). */
  lossless: boolean;
  /** Drop the audio from the export. Ignored when lossless. */
  mute: boolean;
  /** Linear audio gain (1 = unchanged). Ignored when lossless. */
  volume: number;
}

/**
 * Export the range `[start, start + duration)` of `input` to `output`. Normally a
 * re-encode (libx264 / hardware / VP9) into `options.format`, optionally reframed
 * and with audio mute/volume applied; a resolution cap is already baked into the
 * reframe canvas dimensions. When `options.lossless` is true the backend
 * stream-copies instead (no re-encode; reframe/format/encoder/tier/audio are
 * ignored, and `start` should already be keyframe-snapped). Emits
 * "export-progress" events (0.0-1.0) while running.
 */
export function exportClip(
  input: string,
  output: string,
  start: number,
  duration: number,
  options: ExportOptions,
): Promise<void> {
  return invoke<void>("export_clip", {
    input,
    output,
    start,
    duration,
    options: { ...options, reframe: options.reframe ?? undefined },
  });
}

/**
 * The output formats the bundled ffmpeg can produce, as ids (`mp4`/`mov`/`mkv`,
 * plus `webm` when VP9/Opus is available). Detected once and cached backend-side.
 */
export function availableFormats(): Promise<string[]> {
  return invoke<string[]>("available_formats");
}

/**
 * The best available H.264 encoder's user-facing name (e.g. "NVIDIA NVENC" or
 * "Software (libx264)"). Detected once and cached in the backend for the
 * session; always resolves (falls back to libx264).
 */
export function detectEncoder(): Promise<string> {
  return invoke<string>("detect_encoder");
}

/**
 * Resolve the default save path (`<Exports>/<filename>`), creating the Exports
 * folder on demand. Dev builds use the project's `Exports/`; release builds use
 * `<Documents>/ClipSmith/Exports`. Used to default the save dialog.
 */
export function defaultSavePath(filename: string): Promise<string> {
  return invoke<string>("default_save_path", { filename });
}

/**
 * Download a video from a URL and resolve to its local temp path. Direct file
 * links are fetched over HTTP; everything else goes through the bundled yt-dlp
 * sidecar; if yt-dlp has no extractor for the page, the backend falls back to
 * scraping the page (video tags, data attributes, JSON-LD, script and packed-JS
 * URLs, embedded players). Downloads are at source quality. Emits
 * "download-progress" events (0.0-1.0) while running.
 */
export function downloadVideo(url: string): Promise<string> {
  return invoke<string>("download_video", { url });
}

/** Request the in-progress URL download to abort. */
export function cancelDownload(): Promise<void> {
  return invoke<void>("cancel_download");
}

/**
 * Transcode a lightweight H.264 playback proxy for a codec the webview can't
 * decode (e.g. MPEG-4 in `.avi`, HEVC, ProRes); resolves to its local path.
 * Playback uses the proxy; export still cuts the original losslessly.
 */
export function generateProxy(path: string): Promise<string> {
  return invoke<string>("generate_proxy", { path });
}

/** A detection box in normalized source coordinates (0-1) with confidence. */
export interface Detection {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
}

/** Per-frame subject detections from the analyze pass (auto-reframe). */
export interface SubjectFrame {
  t: number;
  faces: Detection[];
  persons: Detection[];
}

/** The analyze pass result: per-frame detections plus scene-cut times (seconds). */
export interface AnalyzeResult {
  frames: SubjectFrame[];
  sceneCuts: number[];
}

/**
 * Analyze a video for subjects (auto-reframe): sample it at `fps` (default 3),
 * detect per frame, and detect scene cuts. `duration` (seconds) drives the
 * progress estimate. Emits "analyze-progress" (0.0-1.0); cancel with
 * {@link cancelAnalyze}.
 */
export function analyzeSubject(
  input: string,
  duration: number,
  fps?: number,
): Promise<AnalyzeResult> {
  return invoke<AnalyzeResult>("analyze_subject", {
    input,
    duration,
    fps: fps ?? null,
  });
}

/** Request the in-progress analyze pass to abort. */
export function cancelAnalyze(): Promise<void> {
  return invoke<void>("cancel_analyze");
}

/**
 * Build the timeline preview strip for a video and resolve to a PNG data URI
 * (no file is written to disk). `durationSecs` comes from the probe; `count` is
 * the number of square thumbnails to tile across the timeline.
 */
export function generateFilmstrip(
  path: string,
  durationSecs: number,
  count: number,
): Promise<string> {
  return invoke<string>("generate_filmstrip", { path, durationSecs, count });
}
