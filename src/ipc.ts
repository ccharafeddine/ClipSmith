// Typed wrappers around the Tauri Rust commands. The frontend never calls
// `invoke` directly; it goes through these so argument and return shapes stay
// in one place.

import { invoke } from "@tauri-apps/api/core";

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

/**
 * Export the range `[start, start + duration)` of `input` to `output` as a
 * lossless stream copy. `start` must be keyframe-snapped and `output`'s
 * extension must equal `input`'s.
 */
export function exportClip(
  input: string,
  output: string,
  start: number,
  duration: number,
): Promise<void> {
  return invoke<void>("export_clip", { input, output, start, duration });
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
