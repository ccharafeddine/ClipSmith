// Shared application state. Plain module-level Solid signals, as the project
// conventions prefer over a store until state grows past ~10 signals.

import { createSignal } from "solid-js";
import { save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import {
  analyzeSubject,
  availableFormats as availableFormatsIpc,
  cancelAnalyze,
  exportClip as exportClipIpc,
  defaultSavePath,
  detectEncoder,
  listKeyframes,
  probeVideo,
  type CropRect,
  type SubjectFrame,
  type VideoMeta,
} from "./ipc";
import { buildCropPath, cropWindow, type CropPoint } from "./autoReframe";
import { formatInfo } from "./formats";
import {
  canvasAspect,
  canvasDims,
  capShorterSide,
  isPreset,
  type Anchor,
  type CanvasRatio,
  type FillStrategy,
  type Reframe,
} from "./reframe";
import { resolutionOption, type QualityTier } from "./quality";

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

// Export quality. `qualityTier` maps to a CRF/preset the backend picks per codec
// ("high" == v1's CRF 18 / medium, the default). `resolutionId` selects an output
// resolution cap; it's applied on the frontend as smaller canvas dimensions, so
// preview and export agree (see `buildReframe`). Both default to the pre-v2
// behaviour (near-lossless, source resolution).
export const [qualityTier, setQualityTier] = createSignal<QualityTier>("high");
export const [resolutionId, setResolutionId] = createSignal("source");

/** The current resolution cap (shorter side, px), or `null` for source size. */
export function resolutionCap(): number | null {
  return resolutionOption(resolutionId()).maxShorter;
}

// Lossless fast-path. When on, the export stream-copies (no re-encode): instant
// and bit-identical, but it can't reframe/crop/scale/convert, so it forces an
// identity cut and snaps the IN handle to a keyframe. `keyframes` are the source
// video's keyframe timestamps (seconds), loaded on open, used for that snapping.
export const [losslessMode, setLosslessMode] = createSignal(false);
export const [keyframes, setKeyframes] = createSignal<number[]>([]);

// Subject-aware auto crop-to-fill (v2 Tier 2). `autoDetections` + `autoSceneCuts`
// are the analyze pass's result, cached per video (ratio- and trim-independent,
// so a ratio/trim change only rebuilds the cheap path, never re-detects).
export const [autoDetections, setAutoDetections] = createSignal<SubjectFrame[] | null>(null);
export const [autoSceneCuts, setAutoSceneCuts] = createSignal<number[]>([]);
export const [autoAnalyzing, setAutoAnalyzing] = createSignal(false);
export const [autoProgress, setAutoProgress] = createSignal(0);
export const [autoError, setAutoError] = createSignal("");

// Audio controls. `muted` drops the audio from the export (and the preview);
// `volume` is a linear gain (1 = unchanged, 0-2 range in the UI) applied on
// export and mirrored in the preview (clamped to the element's 0-1 range there).
export const [muted, setMuted] = createSignal(false);
export const [volume, setVolume] = createSignal(1);

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
  // Auto crop-to-fill needs the analyze pass; kick it off (cached, so a re-select
  // or ratio change is free).
  if (strategy === "auto") void runAutoAnalyze();
}

/**
 * Run the subject analyze pass for auto crop-to-fill and cache its result. No-op
 * if it's already running or already cached for this video (the result is
 * ratio-/trim-independent, so it's reused). Reflects `analyze-progress`; failures
 * surface in `autoError` (the export then falls back to no crop).
 */
export async function runAutoAnalyze(): Promise<void> {
  const input = filePath();
  const m = meta();
  if (!input || !m || autoAnalyzing() || autoDetections()) return;
  setAutoAnalyzing(true);
  setAutoError("");
  setAutoProgress(0);
  const unlisten = await listen<number>("analyze-progress", (e) =>
    setAutoProgress(typeof e.payload === "number" ? e.payload : 0),
  );
  try {
    const { frames, sceneCuts } = await analyzeSubject(input, m.duration_secs);
    setAutoDetections(frames);
    setAutoSceneCuts(sceneCuts);
  } catch (e) {
    setAutoError(String(e));
  } finally {
    unlisten();
    setAutoAnalyzing(false);
  }
}

/** Request the in-progress analyze pass to abort. */
export function cancelAutoAnalyze(): void {
  void cancelAnalyze();
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
    // Quality/resolution default to v1 behaviour (near-lossless, source size).
    setQualityTier("high");
    setResolutionId("source");
    // Lossless mode off by default; (re-)load the keyframes it snaps IN to.
    setLosslessMode(false);
    setKeyframes([]);
    refreshKeyframes(path);
    // Audio defaults: unmuted, full volume.
    setMuted(false);
    setVolume(1);
    // Clear cached subject analysis (it's per-video).
    setAutoDetections(null);
    setAutoSceneCuts([]);
    setAutoAnalyzing(false);
    setAutoProgress(0);
    setAutoError("");

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
  setQualityTier("high");
  setResolutionId("source");
  setLosslessMode(false);
  setKeyframes([]);
  setMuted(false);
  setVolume(1);
  setAutoDetections(null);
  setAutoSceneCuts([]);
  setAutoAnalyzing(false);
  setAutoProgress(0);
  setAutoError("");
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
 * Load the source's keyframe timestamps for lossless-mode IN snapping. Silent on
 * failure — lossless still works (the backend's `-ss` snaps to a keyframe too),
 * the handle just won't visibly snap.
 */
export function refreshKeyframes(path: string): void {
  listKeyframes(path)
    .then((ks) => {
      // Ignore a late result if another video was loaded/closed meanwhile.
      if (filePath() === path) setKeyframes(ks);
    })
    .catch(() => {});
}

/** The keyframe timestamp nearest to `t`, or `t` itself if none are loaded. */
export function nearestKeyframe(t: number): number {
  const ks = keyframes();
  if (ks.length === 0) return t;
  let best = ks[0];
  let bestDist = Math.abs(t - best);
  for (const k of ks) {
    const d = Math.abs(t - k);
    if (d < bestDist) {
      best = k;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Snap the IN point to the nearest keyframe, kept strictly before OUT. Used by
 * lossless mode so the handle sits where the stream copy will actually start
 * (a copy can only begin on a keyframe).
 */
export function snapInToKeyframe(): void {
  if (keyframes().length === 0) return;
  const limit = Math.max(0, outPoint() - MIN_CLIP);
  const snapped = Math.min(nearestKeyframe(inPoint()), limit);
  setInPoint(snapped);
  seekTo(snapped);
}

/**
 * Toggle the lossless (stream-copy) export mode. Turning it on forces an
 * identity cut — copy can't reframe, crop, scale, or convert — by resetting the
 * reframe/resolution controls, and snaps IN to a keyframe so the handle matches
 * where the copy will begin.
 */
export function setLossless(on: boolean): void {
  setLosslessMode(on);
  if (on) {
    setReframeRatio("original");
    setFillStrategy("blur");
    setCropRect(null);
    setCropMode(false);
    setResolutionId("source");
    snapInToKeyframe();
  }
}

/**
 * Build the reframe payload for the current settings, or `null` for an identity
 * export (v1's plain frame-accurate cut). `original` is identity unless a
 * resolution cap downscales it; `freeform` is identity until a crop box exists,
 * then it's an unconstrained crop (output == rect); presets emit a fill strategy
 * over a computed canvas. Any resolution cap is folded into the canvas
 * dimensions here (the single source of truth for output size), so the preview
 * and the export always agree and the backend needs no separate resolution knob.
 */
export function buildReframe(): Reframe | null {
  const m = meta();
  if (!m) return null;
  const ratio = reframeRatio();
  const cap = resolutionCap();

  if (ratio === "original") {
    // No cap (or the source already fits) → true identity (v1's no-filter cut).
    if (cap === null || Math.min(m.width, m.height) <= cap) return null;
    // A downscale of an un-reframed clip: crop the full frame (a no-op) and let
    // the backend scale it to the capped canvas. Reuses the tested crop→scale
    // path and produces a clean downscale with no bars.
    const [canvasW, canvasH] = capShorterSide([m.width, m.height], cap);
    return {
      canvasW,
      canvasH,
      strategy: "crop",
      anchor: "center",
      padColor: padColor(),
      crop: { x: 0, y: 0, w: m.width, h: m.height },
    };
  }

  if (ratio === "freeform") {
    const crop = cropRect();
    if (!crop) return null;
    // Canvas == crop dims → backend emits a plain `crop=` (v1 lossless framing).
    // A resolution cap shrinks the canvas below the rect, so the backend then
    // scales the cropped region down (crop→scale) instead.
    const [canvasW, canvasH] = capShorterSide([crop.w, crop.h], cap);
    return {
      canvasW,
      canvasH,
      strategy: "crop",
      anchor: "center",
      padColor: padColor(),
      crop,
    };
  }

  if (!isPreset(ratio)) return null;
  const [canvasW, canvasH] = capShorterSide(
    canvasDims(ratio, m.width, m.height),
    cap,
  );
  const strategy = fillStrategy();

  if (strategy === "auto") return buildAutoReframe(m, canvasW, canvasH);

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

/** Round to the nearest even integer ≥ 2 (libx264 needs even crop dims). */
function evenInt(v: number): number {
  const n = Math.max(2, Math.round(v));
  return n % 2 === 0 ? n : n - 1;
}

/**
 * Build the auto crop-to-fill reframe: turn the cached per-frame detections into
 * a smoothed crop path for the current canvas + trim range, then convert it to a
 * source-pixel [`AutoPath`] the backend drives as a time-varying crop. When
 * analysis hasn't produced usable detections yet (still running, or none in the
 * trim range) it falls back to a **static centered** crop so the chosen canvas
 * ratio is always honored — never a silent identity export.
 *
 * Times are made **clip-relative** (minus `inPoint`) because the export's `-ss`
 * resets the crop expression's `t` to 0 at the trimmed start.
 */
function buildAutoReframe(
  m: VideoMeta,
  canvasW: number,
  canvasH: number,
): Reframe {
  const sourceAr = m.width / m.height;
  const canvasAr = canvasW / canvasH;
  const inP = inPoint();
  const outP = outPoint();

  // Try the tracked path; otherwise a single centered control point (static crop).
  let winW: number;
  let winH: number;
  let points: CropPoint[];
  const dets = autoDetections();
  const sub = dets
    ? dets.filter((f) => f.t >= inP && f.t <= outP).map((f) => ({ ...f, t: f.t - inP }))
    : [];
  const cuts = autoSceneCuts()
    .filter((t) => t > inP && t < outP)
    .map((t) => t - inP);
  const path = sub.length
    ? buildCropPath(sub, sourceAr, canvasAr, { sceneCuts: cuts })
    : null;
  if (path && path.points.length) {
    winW = path.winW;
    winH = path.winH;
    points = path.points;
  } else {
    const win = cropWindow(sourceAr, canvasAr);
    winW = win.winW;
    winH = win.winH;
    points = [{ t: 0, cx: 0.5, cy: 0.5 }];
  }

  const cropW = evenInt(winW * m.width);
  const cropH = evenInt(winH * m.height);
  const clampTo = (v: number, hi: number) => Math.min(hi, Math.max(0, v));
  // Normalized center → source-pixel top-left corner, clamped into the frame.
  const x = points.map((p) => ({
    t: p.t,
    v: clampTo(p.cx * m.width - cropW / 2, m.width - cropW),
  }));
  const y = points.map((p) => ({
    t: p.t,
    v: clampTo(p.cy * m.height - cropH / 2, m.height - cropH),
  }));
  return {
    canvasW,
    canvasH,
    strategy: "crop", // backend strategy; auto is a UI-only mode of crop
    anchor: "center",
    padColor: padColor(),
    crop: null,
    auto: { cropW, cropH, x, y },
  };
}

/**
 * Export the current trim range. Normally a re-encode into the chosen format
 * (optionally reframed); in **lossless** mode a stream copy into the source
 * container (instant, bit-identical, no reframe). Opens a save dialog defaulting
 * to `{source_stem}_clip.{ext}` in the Exports folder, then runs the export while
 * reflecting progress. No-op if no file is loaded, an export is already in
 * flight, or the user cancels the dialog.
 */
export async function exportClip(): Promise<void> {
  const input = filePath();
  if (!input || exporting()) return;

  const lossless = losslessMode();
  const start = inPoint();
  const clipDuration = outPoint() - start;
  if (clipDuration <= 0) return;

  // Lossless keeps the source container (a copy can't change codecs); a
  // re-encode uses the chosen output format.
  const ext = lossless
    ? extensionOf(input) || "mp4"
    : formatInfo(outputFormat()).id;
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
    await exportClipIpc(input, output, start, clipDuration, {
      reframe: lossless ? null : buildReframe(),
      format: outputFormat(),
      useHardware: hwAccel(),
      tier: qualityTier(),
      lossless,
      mute: muted(),
      volume: volume(),
    });
    setExportedPath(output);
  } catch (e) {
    setExportError(String(e));
  } finally {
    unlisten();
    setExporting(false);
  }
}
