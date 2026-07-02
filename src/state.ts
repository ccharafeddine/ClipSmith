// Shared application state. Plain module-level Solid signals, as the project
// conventions prefer over a store until state grows past ~10 signals.

import { createSignal } from "solid-js";
import { save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import {
  availableFormats as availableFormatsIpc,
  exportClip as exportClipIpc,
  defaultSavePath,
  detectEncoder,
  probeVideo,
  type CropRect,
  type VideoMeta,
} from "./ipc";
import { formatInfo } from "./formats";
import {
  canvasAspect,
  canvasDims,
  isPreset,
  type Anchor,
  type CanvasRatio,
  type FillStrategy,
  type Reframe,
} from "./reframe";

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

// Reframe (v2). The output canvas ratio plus a fill strategy is the primary
// aspect control; the old crop is folded in as the `freeform` ratio (an
// unconstrained crop, output == rect) and as the manual mode of crop-to-fill.
export const [reframeRatio, setReframeRatio] = createSignal<CanvasRatio>("original");
export const [fillStrategy, setFillStrategy] = createSignal<FillStrategy>("blur");
export const [reframeAnchor, setReframeAnchor] = createSignal<Anchor>("center");
export const [padColor, setPadColor] = createSignal("#000000");

// Crop. `cropRect` is the selection in source pixels (or null for no crop);
// `cropMode` toggles the on-video crop overlay. In v2 it backs the `freeform`
// ratio (and, from Step 2, the manual crop-to-fill mode).
export const [cropRect, setCropRect] = createSignal<CropRect | null>(null);
export const [cropMode, setCropMode] = createSignal(false);

// Visible timeline window, in seconds, for zoom. [viewStart, viewEnd] is a
// sub-range of [0, duration] that the Timeline scales to fill its width; the
// whole clip is shown when the window equals the full duration.
export const [viewStart, setViewStart] = createSignal(0);
export const [viewEnd, setViewEnd] = createSignal(0);

// Output format. `outputFormat` is a format id (mp4/mov/mkv/webm; mp4 default —
// ClipSmith is also a converter). `availableFormatIds` is what the bundled
// ffmpeg can actually produce (webm needs VP9/Opus), filled in on load.
export const [outputFormat, setOutputFormat] = createSignal("mp4");
export const [availableFormatIds, setAvailableFormatIds] = createSignal<string[]>([
  "mp4",
  "mov",
  "mkv",
]);

// Hardware acceleration. `hwAccel` true (default) lets the backend use a
// detected hardware encoder; false forces libx264. `encoderLabel` is the
// detected best encoder's name, shown so the user knows what Auto resolved to.
export const [hwAccel, setHwAccel] = createSignal(true);
export const [encoderLabel, setEncoderLabel] = createSignal("");

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
  // Clamp the low bound independently of duration so a negative `t` (e.g. a
  // frame-step fired before metadata resolves, when duration() is still 0) can
  // never set a negative currentTime.
  const clamped = Math.min(Math.max(t, 0), duration() || Number.POSITIVE_INFINITY);
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

/** Seed a centered 80% crop box (source pixels) so there's something to drag. */
function seedCrop(): void {
  const m = meta();
  if (!m || cropRect()) return;
  const w = Math.round(m.width * 0.8);
  const h = Math.round(m.height * 0.8);
  const x = Math.round((m.width - w) / 2);
  const y = Math.round((m.height - h) / 2);
  setCropRect({ x, y, w, h });
}

/**
 * Seed a centered crop box locked to `ar` (canvas w/h), sized to ~90% of the
 * source's bounding box. Used when entering manual crop-to-fill so the initial
 * rectangle already matches the output canvas aspect.
 */
function seedLockedCrop(ar: number): void {
  const m = meta();
  if (!m) return;
  let w = m.width * 0.9;
  let h = w / ar;
  if (h > m.height * 0.9) {
    h = m.height * 0.9;
    w = h * ar;
  }
  setCropRect({
    x: Math.round((m.width - w) / 2),
    y: Math.round((m.height - h) / 2),
    w: Math.round(w),
    h: Math.round(h),
  });
}

/**
 * Reconcile the crop overlay with the current ratio + strategy:
 * - `freeform` → an unconstrained draggable crop (output == the rectangle).
 * - preset + `crop` → manual crop-to-fill: a crop box AR-locked to the canvas,
 *   scaled to the canvas on export. Re-seeded so it always matches the aspect.
 * - anything else → no crop overlay.
 */
function syncCropMode(): void {
  const ratio = reframeRatio();
  const m = meta();
  if (ratio === "freeform") {
    seedCrop();
    setCropMode(true);
  } else if (isPreset(ratio) && fillStrategy() === "crop") {
    if (m) seedLockedCrop(canvasAspect(ratio, m.width, m.height));
    setCropMode(true);
  } else {
    setCropMode(false);
    setCropRect(null);
  }
}

/**
 * Pick an output canvas ratio. `freeform` turns the source into a draggable
 * crop; a preset uses the current fill strategy (and, for crop-to-fill, an
 * AR-locked crop box). See [`syncCropMode`].
 */
export function chooseRatio(ratio: CanvasRatio): void {
  setReframeRatio(ratio);
  syncCropMode();
}

/** Pick a fill strategy for the current preset, reconciling the crop overlay. */
export function chooseStrategy(strategy: FillStrategy): void {
  setFillStrategy(strategy);
  syncCropMode();
}

/**
 * The aspect ratio (w/h) the crop rectangle is locked to, or `null` when it's
 * free. Manual crop-to-fill locks the box to the canvas aspect; `freeform` is
 * unconstrained. Read by the crop overlay to constrain resizing.
 */
export function cropAspectLock(): number | null {
  const m = meta();
  const ratio = reframeRatio();
  if (m && isPreset(ratio) && fillStrategy() === "crop") {
    return canvasAspect(ratio, m.width, m.height);
  }
  return null;
}

/**
 * The aspect ratio (w/h) the preview stage should take: the output canvas for a
 * preset ratio, or the source aspect for `original`/`freeform`. Drives the
 * `--aspect` CSS var so the player reshapes to what will be exported.
 */
export function stageAspect(): number {
  const m = meta();
  if (!m || m.height === 0) return 16 / 9;
  // While editing a crop (freeform or manual crop-to-fill) the stage shows the
  // whole source frame so the draggable box has the full picture to work with.
  if (cropMode()) return m.width / m.height;
  const r = reframeRatio();
  return isPreset(r) ? canvasAspect(r, m.width, m.height) : m.width / m.height;
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
    // Clear any export result/error from the previous video so a stale message
    // doesn't stick when switching sources directly (without hitting close).
    setExportError("");
    setExportedPath(null);
    setExportProgress(0);
    // Reframe defaults to "original" (identity — v1's plain frame-accurate cut).
    setReframeRatio("original");
    setFillStrategy("blur");
    setReframeAnchor("center");
    setPadColor("#000000");

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
    // Learn which encoder and output formats are available so the export panel
    // can show them (cached backend-side, so these only probe once per session).
    refreshEncoder();
    refreshFormats();
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
  setReframeRatio("original");
  setFillStrategy("blur");
  setReframeAnchor("center");
  setPadColor("#000000");
  setViewStart(0);
  setViewEnd(0);
  setExportError("");
  setExportedPath(null);
  setExportProgress(0);
}

/**
 * Ask the backend which H.264 encoder it will use and cache the label for the
 * UI. Cheap and idempotent (the backend caches detection for the session);
 * safe to call on load. Silent on failure — the label just stays as-is.
 */
export function refreshEncoder(): void {
  detectEncoder()
    .then(setEncoderLabel)
    .catch(() => {});
}

/**
 * Ask the backend which output formats the bundled ffmpeg can produce and cache
 * the list for the format picker. Cheap and idempotent (cached backend-side).
 * If the current format somehow isn't available, fall back to mp4.
 */
export function refreshFormats(): void {
  availableFormatsIpc()
    .then((ids) => {
      if (ids.length) setAvailableFormatIds(ids);
      if (!ids.includes(outputFormat())) setOutputFormat("mp4");
    })
    .catch(() => {});
}

/**
 * Build the reframe payload for the current settings, or `null` for an identity
 * export (v1's plain frame-accurate cut). `original` is always identity;
 * `freeform` is identity until a crop box exists, then it's an unconstrained
 * crop (output == rect). Presets emit a fill strategy over a computed canvas.
 */
export function buildReframe(): Reframe | null {
  const m = meta();
  if (!m) return null;
  const ratio = reframeRatio();

  if (ratio === "original") return null;

  if (ratio === "freeform") {
    const crop = cropRect();
    if (!crop) return null;
    // Canvas == crop dims → backend emits a plain `crop=` (v1 lossless framing).
    return {
      canvasW: crop.w,
      canvasH: crop.h,
      strategy: "crop",
      anchor: "center",
      padColor: padColor(),
      crop,
    };
  }

  if (!isPreset(ratio)) return null;
  const [canvasW, canvasH] = canvasDims(ratio, m.width, m.height);
  const strategy = fillStrategy();
  return {
    canvasW,
    canvasH,
    strategy,
    anchor: reframeAnchor(),
    padColor: padColor(),
    // Manual crop-to-fill sends the AR-locked rectangle; the backend crops it
    // and scales to the canvas. Blur/pad carry no crop.
    crop: strategy === "crop" ? cropRect() : null,
  };
}

/**
 * Export the current trim range as a frame-accurate H.264/AAC mp4, optionally
 * reframed into a chosen output canvas (blur-fill / pad / crop-to-fill). Opens a
 * save dialog defaulting to `{source_stem}_clip.mp4` in the Exports folder, then
 * runs the libx264 re-encode while reflecting progress. No-op if no file is
 * loaded, an export is already in flight, or the user cancels the dialog. Output
 * is always `.mp4`, since the re-encode is no longer bound to the source
 * container.
 */
export async function exportClip(): Promise<void> {
  const input = filePath();
  if (!input || exporting()) return;

  const start = inPoint();
  const clipDuration = outPoint() - start;
  if (clipDuration <= 0) return;

  const ext = formatInfo(outputFormat()).id;
  const name = fileName();
  const dot = name.lastIndexOf(".");
  const stem = dot === -1 ? name : name.slice(0, dot);
  const defaultName = `${stem}_clip.${ext}`;

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
    filters: [{ name: "Video", extensions: [ext] }],
  });
  if (typeof output !== "string") return;

  setExportError("");
  setExportedPath(null);
  setExportProgress(0);
  setExporting(true);
  // Reflect the backend's re-encode progress on the Export button / bar.
  const unlisten = await listen<number>("export-progress", (e) => {
    setExportProgress(typeof e.payload === "number" ? e.payload : 0);
  });
  try {
    await exportClipIpc(
      input,
      output,
      start,
      clipDuration,
      buildReframe(),
      outputFormat(),
      hwAccel(),
    );
    setExportedPath(output);
  } catch (e) {
    setExportError(String(e));
  } finally {
    unlisten();
    setExporting(false);
  }
}
