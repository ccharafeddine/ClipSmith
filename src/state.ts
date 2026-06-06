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
