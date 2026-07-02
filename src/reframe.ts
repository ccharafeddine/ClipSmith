// Reframe model (v2): the target aspect becomes an output *canvas*, and a fill
// strategy decides how the source fills it. This replaces v1's single
// destructive crop as the primary aspect control.
//
// Pure helpers only — no Solid signals — so the same math drives both the live
// preview and the numbers handed to the backend. Canvas dimensions are computed
// here (single source of truth) and passed to `cutter.rs` as even integers, so
// what you preview is exactly what you export.

import type { CropRect } from "./ipc";

/**
 * Output canvas ratios. `original` keeps the source aspect (identity — no bars,
 * nothing cropped). `freeform` is the escape hatch: an unconstrained crop whose
 * output dimensions are the crop rectangle itself (v1's lossless framing).
 */
export const CANVAS_RATIOS = [
  "original",
  "9:16",
  "1:1",
  "4:5",
  "16:9",
  "freeform",
] as const;
export type CanvasRatio = (typeof CANVAS_RATIOS)[number];

/** How the source fills the canvas. Mirrors `cutter::Strategy`. */
export type FillStrategy = "blur" | "pad" | "crop";

/**
 * Where the fitted source sits along the axis that has bars: top/center/bottom
 * for a portrait canvas, left/center/right for a landscape one. Mirrors
 * `cutter::Anchor`.
 */
export type Anchor = "start" | "center" | "end";

/** Human labels for a ratio chip. */
export function ratioLabel(r: CanvasRatio): string {
  switch (r) {
    case "original":
      return "Original";
    case "freeform":
      return "Freeform";
    default:
      return r;
  }
}

/**
 * A preset ratio as a numeric width/height, or `null` for `original`/`freeform`
 * (which have no fixed target aspect).
 */
export function ratioValue(r: CanvasRatio): number | null {
  switch (r) {
    case "9:16":
      return 9 / 16;
    case "1:1":
      return 1;
    case "4:5":
      return 4 / 5;
    case "16:9":
      return 16 / 9;
    default:
      return null;
  }
}

/** Whether a ratio is a fixed-aspect preset (bars/anchor/strategy apply). */
export function isPreset(r: CanvasRatio): boolean {
  return ratioValue(r) !== null;
}

/** Round to the nearest even integer, with a floor of 2 (libx264 needs even). */
function even(v: number): number {
  const n = Math.max(2, Math.round(v));
  return n % 2 === 0 ? n : n - 1;
}

/**
 * Output canvas dimensions for a preset ratio, given the source size. The canvas
 * never exceeds the source's bounding box (no upscaling of the canvas itself):
 * lock to the source height first, and only fall back to width-locked if that
 * would overflow the source width. `original`/`freeform` return the source size.
 */
export function canvasDims(
  r: CanvasRatio,
  srcW: number,
  srcH: number,
): [number, number] {
  const ar = ratioValue(r);
  if (ar === null) return [even(srcW), even(srcH)];

  let h = srcH;
  let w = srcH * ar;
  if (w > srcW) {
    w = srcW;
    h = srcW / ar;
  }
  return [even(w), even(h)];
}

/** The canvas aspect (w/h) to shape the preview stage to, for a preset. */
export function canvasAspect(r: CanvasRatio, srcW: number, srcH: number): number {
  const [w, h] = canvasDims(r, srcW, srcH);
  return w / h;
}

/**
 * Which axis carries the letterbox bars when fitting the source inside a preset
 * canvas: `"vertical"` = bars top/bottom (source wider than canvas),
 * `"horizontal"` = bars left/right (source taller), or `null` when the aspects
 * match (no bars, so anchor is irrelevant).
 */
export function barsAxis(
  r: CanvasRatio,
  srcW: number,
  srcH: number,
): "vertical" | "horizontal" | null {
  const ar = ratioValue(r);
  if (ar === null) return null;
  const srcAr = srcW / srcH;
  if (Math.abs(srcAr - ar) < 1e-3) return null;
  return srcAr > ar ? "vertical" : "horizontal";
}

/** CSS `object-position` for an anchored, `contain`-fitted preview video. */
export function anchorObjectPosition(
  anchor: Anchor,
  axis: "vertical" | "horizontal" | null,
): string {
  if (axis === "vertical") {
    // Bars top/bottom → anchor moves the frame up/down.
    if (anchor === "start") return "center top";
    if (anchor === "end") return "center bottom";
    return "center center";
  }
  if (axis === "horizontal") {
    // Bars left/right → anchor moves the frame left/right.
    if (anchor === "start") return "left center";
    if (anchor === "end") return "right center";
    return "center center";
  }
  return "center center";
}

/** The two anchor end labels for the current bar axis (center is implicit). */
export function anchorLabels(
  axis: "vertical" | "horizontal" | null,
): { start: string; center: string; end: string } {
  if (axis === "horizontal") {
    return { start: "Left", center: "Center", end: "Right" };
  }
  return { start: "Top", center: "Center", end: "Bottom" };
}

/**
 * The payload handed to the backend `export_clip` command. Matches
 * `cutter::Reframe` (serde `camelCase`). `null` means an identity export (v1's
 * plain frame-accurate cut, no filter).
 */
export interface Reframe {
  canvasW: number;
  canvasH: number;
  strategy: FillStrategy;
  anchor: Anchor;
  padColor: string;
  crop: CropRect | null;
}
