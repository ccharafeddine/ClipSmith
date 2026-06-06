// Shared application state. Plain module-level Solid signals, as the project
// conventions prefer over a store until state grows past ~10 signals.

import { createSignal } from "solid-js";
import { listKeyframes, probeVideo, type VideoMeta } from "./ipc";

/** Video container extensions ClipSmith will open. */
export const ALLOWED_EXTENSIONS = [
  "mp4",
  "mov",
  "mkv",
  "webm",
  "avi",
  "m4v",
] as const;

export const [filePath, setFilePath] = createSignal<string | null>(null);
export const [meta, setMeta] = createSignal<VideoMeta | null>(null);
export const [keyframes, setKeyframes] = createSignal<number[]>([]);
export const [loading, setLoading] = createSignal(false);
export const [loadError, setLoadError] = createSignal("");

// Playback state, shared between VideoPlayer (which drives it) and Timeline
// (which visualizes and scrubs it).
export const [currentTime, setCurrentTime] = createSignal(0);
export const [duration, setDuration] = createSignal(0);
export const [playing, setPlaying] = createSignal(false);

// Trim range. inPoint is always a keyframe (snapped); outPoint is free.
export const [inPoint, setInPoint] = createSignal(0);
export const [outPoint, setOutPoint] = createSignal(0);

/** Shortest selectable clip, in seconds, keeping IN strictly before OUT. */
export const MIN_CLIP = 0.05;

// The active <video> element, registered by VideoPlayer so other components
// and helpers can drive playback without prop-drilling a ref.
let videoEl: HTMLVideoElement | null = null;

export function registerVideo(el: HTMLVideoElement | null): void {
  videoEl = el;
}

/** Seek the video (and the playhead signal) to `t`, clamped to [0, duration]. */
export function seekTo(t: number): void {
  const max = duration() || t;
  const clamped = Math.min(Math.max(t, 0), max);
  if (videoEl) videoEl.currentTime = clamped;
  setCurrentTime(clamped);
}

/** Toggle play/pause on the registered video element. */
export function togglePlay(): void {
  if (!videoEl) return;
  if (videoEl.paused) {
    // Resume inside the trim range, not wherever a previous loop left off.
    if (currentTime() >= outPoint() || currentTime() < inPoint()) {
      seekTo(inPoint());
    }
    void videoEl.play();
  } else {
    videoEl.pause();
  }
}

/**
 * Snap a requested IN time to the nearest keyframe at or before it. The IN
 * handle is magnetic: with `-c copy` the cut must start on a keyframe.
 * Falls back to 0.0 when nothing qualifies. `kfs` must be sorted ascending.
 */
export function snapIn(time: number, kfs: number[]): number {
  let snapped = 0;
  for (const kf of kfs) {
    if (kf <= time) snapped = kf;
    else break;
  }
  return snapped;
}

/** The file name (no directory) of the currently loaded video, or "". */
export function fileName(): string {
  const path = filePath();
  if (!path) return "";
  // Handle both Windows and POSIX separators.
  return path.split(/[\\/]/).pop() ?? path;
}

/** The lowercased extension (no dot) of a path, or "". */
export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Whether a path's extension is in the allowlist. */
export function isAllowed(path: string): boolean {
  return (ALLOWED_EXTENSIONS as readonly string[]).includes(extensionOf(path));
}

/**
 * Load a video: validate the extension, probe it, and store path + metadata.
 * Clears any previous error. Safe to call from the picker or a future drop.
 */
export async function loadVideo(path: string): Promise<void> {
  if (!isAllowed(path)) {
    setLoadError(
      `Unsupported file type ".${extensionOf(path)}". Supported: ${ALLOWED_EXTENSIONS.join(", ")}.`,
    );
    return;
  }

  setLoadError("");
  setLoading(true);
  try {
    const probed = await probeVideo(path);
    setFilePath(path);
    setMeta(probed);

    // Initialize transport + trim range to the whole clip. VideoPlayer refines
    // duration from the element on loadedmetadata.
    setDuration(probed.duration_secs);
    setCurrentTime(0);
    setPlaying(false);
    setInPoint(0);
    setOutPoint(probed.duration_secs);

    // Keyframes are needed for IN snapping but not for playback, so a failure
    // here degrades gracefully to [0.0] rather than failing the whole load.
    try {
      const kfs = await listKeyframes(path);
      setKeyframes(kfs.length > 0 ? kfs : [0]);
    } catch (e) {
      console.error("list_keyframes failed", e);
      setKeyframes([0]);
    }
  } catch (e) {
    setFilePath(null);
    setMeta(null);
    setKeyframes([]);
    setLoadError(String(e));
  } finally {
    setLoading(false);
  }
}
