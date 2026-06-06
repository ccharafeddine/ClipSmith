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
