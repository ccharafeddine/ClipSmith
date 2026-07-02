// Typed wrappers around the Tauri Rust commands. The frontend never calls
// `invoke` directly; it goes through these so argument and return shapes stay
// in one place.

import { invoke } from "@tauri-apps/api/core";
import type { Reframe } from "./reframe";

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

/**
 * Export the range `[start, start + duration)` of `input` to `output` as a
 * frame-accurate H.264/AAC mp4 (libx264 re-encode), optionally reframed into a
 * chosen output canvas (blur-fill / pad / crop-to-fill). `reframe` of `null`
 * means an identity export (v1's plain frame-accurate cut). `output` is always
 * `.mp4`. Emits "export-progress" events (0.0-1.0) while running.
 */
export function exportClip(
  input: string,
  output: string,
  start: number,
  duration: number,
  reframe: Reframe | null,
  format: string,
  useHardware: boolean,
): Promise<void> {
  return invoke<void>("export_clip", {
    input,
    output,
    start,
    duration,
    options: { reframe: reframe ?? undefined, format, useHardware },
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
 * sidecar. Emits "download-progress" events (0.0-1.0) while running.
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
