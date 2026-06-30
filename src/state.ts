// Shared application state. Plain module-level Solid signals, as the project
// conventions prefer over a store until state grows past ~10 signals.

import { createSignal } from "solid-js";
import { save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import {
  exportClip as exportClipIpc,
  defaultSavePath,
  probeVideo,
  type CropRect,
  type VideoMeta,
} from "./ipc";

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
// Timeline preview strip as a PNG data URI, or "" until generated / on failure.
export const [filmstripSrc, setFilmstripSrc] = createSignal("");
export const [loading, setLoading] = createSignal(false);
export const [loadError, setLoadError] = createSignal("");

// Playback state, shared between VideoPlayer (which drives it) and Timeline
// (which visualizes and scrubs it).
export const [currentTime, setCurrentTime] = createSignal(0);
export const [duration, setDuration] = createSignal(0);
export const [playing, setPlaying] = createSignal(false);

// Trim range. Both handles are free and frame-accurate: the export re-encodes,
// so the cut no longer has to start on a keyframe.
export const [inPoint, setInPoint] = createSignal(0);
export const [outPoint, setOutPoint] = createSignal(0);

// Crop. `cropRect` is the selection in source pixels (or null for no crop);
// `cropMode` toggles the on-video crop overlay.
export const [cropRect, setCropRect] = createSignal<CropRect | null>(null);
export const [cropMode, setCropMode] = createSignal(false);

// Visible timeline window, in seconds, for zoom. [viewStart, viewEnd] is a
// sub-range of [0, duration] that the Timeline scales to fill its width; the
// whole clip is shown when the window equals the full duration.
export const [viewStart, setViewStart] = createSignal(0);
export const [viewEnd, setViewEnd] = createSignal(0);

// Export state, driven by the ExportPanel.
export const [exporting, setExporting] = createSignal(false);
export const [exportError, setExportError] = createSignal("");
export const [exportedPath, setExportedPath] = createSignal<string | null>(null);
// Re-encode progress, 0.0-1.0, fed by the backend's "export-progress" events.
export const [exportProgress, setExportProgress] = createSignal(0);

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
 * Set the IN point at the current playhead (free, frame-accurate), kept strictly
 * before OUT.
 */
export function setInAtPlayhead(): void {
  const limit = Math.max(0, outPoint() - MIN_CLIP);
  setInPoint(Math.min(currentTime(), limit));
}

/** Set the OUT point at the current playhead (free), kept strictly after IN. */
export function setOutAtPlayhead(): void {
  const lo = inPoint() + MIN_CLIP;
  setOutPoint(Math.min(Math.max(currentTime(), lo), duration()));
}

/** Pause and seek by one source frame (1 / fps) in the given direction. */
export function stepFrame(direction: 1 | -1): void {
  const m = meta();
  const fps = m && m.fps_den > 0 ? m.fps_num / m.fps_den : 30;
  const frameDur = fps > 0 ? 1 / fps : 1 / 30;
  if (videoEl) videoEl.pause();
  setPlaying(false);
  seekTo(currentTime() + direction * frameDur);
}

/**
 * Toggle the crop overlay. Entering crop mode with no rectangle yet seeds a
 * centered 80% box (in source pixels) so there's something to drag.
 */
export function toggleCropMode(): void {
  const m = meta();
  if (!m) return;
  const next = !cropMode();
  if (next && !cropRect()) {
    const w = Math.round(m.width * 0.8);
    const h = Math.round(m.height * 0.8);
    const x = Math.round((m.width - w) / 2);
    const y = Math.round((m.height - h) / 2);
    setCropRect({ x, y, w, h });
  }
  setCropMode(next);
}

/** Remove the crop entirely and leave crop mode. */
export function clearCrop(): void {
  setCropRect(null);
  setCropMode(false);
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
    setFilmstripSrc("");
    setCropRect(null);
    setCropMode(false);

    // Initialize transport + trim range to the whole clip. VideoPlayer refines
    // duration from the element on loadedmetadata.
    setDuration(probed.duration_secs);
    setCurrentTime(0);
    setPlaying(false);
    setInPoint(0);
    setOutPoint(probed.duration_secs);
    // Start fully zoomed out: the window is the whole clip.
    setViewStart(0);
    setViewEnd(probed.duration_secs);
    // The preview strip is generated by the Timeline once it has measured its
    // width (so the thumbnail count tiles cleanly); see Timeline.tsx.
  } catch (e) {
    setFilePath(null);
    setMeta(null);
    setFilmstripSrc("");
    setLoadError(String(e));
  } finally {
    setLoading(false);
  }
}

/**
 * Remove the loaded video without opening another: release the <video> handle
 * (so the source file is no longer locked on disk) and reset all source-derived
 * state back to the empty state. Safe to call from the close button.
 */
export function closeVideo(): void {
  if (videoEl) {
    videoEl.pause();
    videoEl.removeAttribute("src");
    videoEl.load();
  }
  setFilePath(null);
  setMeta(null);
  setFilmstripSrc("");
  setLoadError("");
  setCurrentTime(0);
  setDuration(0);
  setPlaying(false);
  setInPoint(0);
  setOutPoint(0);
  setCropRect(null);
  setCropMode(false);
  setViewStart(0);
  setViewEnd(0);
  setExportError("");
  setExportedPath(null);
  setExportProgress(0);
}

/**
 * Export the current trim range as a frame-accurate H.264/AAC mp4, optionally
 * cropped. Opens a save dialog defaulting to `{source_stem}_clip.mp4` in the
 * Exports folder, then runs the libx264 re-encode while reflecting progress.
 * No-op if no file is loaded, an export is already in flight, or the user
 * cancels the dialog. Output is always `.mp4`, since the re-encode is no longer
 * bound to the source container.
 */
export async function exportClip(): Promise<void> {
  const input = filePath();
  if (!input || exporting()) return;

  const start = inPoint();
  const clipDuration = outPoint() - start;
  if (clipDuration <= 0) return;

  const name = fileName();
  const dot = name.lastIndexOf(".");
  const stem = dot === -1 ? name : name.slice(0, dot);
  const defaultName = `${stem}_clip.mp4`;

  // Default the dialog into the Exports folder (Rust creates it on demand).
  // If that can't be resolved, fall back to a bare filename so the dialog still
  // opens and the user can navigate anywhere.
  let defaultPath = defaultName;
  try {
    defaultPath = await defaultSavePath(defaultName);
  } catch {
    defaultPath = defaultName;
  }

  const output = await save({
    defaultPath,
    filters: [{ name: "Video", extensions: ["mp4"] }],
  });
  if (typeof output !== "string") return;

  setExportError("");
  setExportProgress(0);
  setExporting(true);
  // Reflect the backend's re-encode progress on the Export button / bar.
  const unlisten = await listen<number>("export-progress", (e) => {
    setExportProgress(typeof e.payload === "number" ? e.payload : 0);
  });
  try {
    await exportClipIpc(input, output, start, clipDuration, cropRect());
    setExportedPath(output);
  } catch (e) {
    setExportError(String(e));
  } finally {
    unlisten();
    setExporting(false);
  }
}
