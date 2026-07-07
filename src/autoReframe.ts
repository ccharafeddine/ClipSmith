// Subject-aware auto-reframe, phase two (v2 Tier 2, M2): turn the analyze pass's
// raw per-frame detections into a smoothed crop path.
//
// Pure geometry, deliberately on the frontend (like `reframe.ts`'s canvas math):
// detection is expensive and ratio-independent (done once in Rust), but the crop
// path is cheap and ratio-*dependent*, so rebuilding it when the canvas ratio
// changes must be instant and client-side. The resulting control points are
// handed to the backend for the time-varying `crop` (M3) and drive the live
// preview overlay (M5) — one source of truth for both.
//
// The model: for a preset canvas the crop window is the largest canvas-aspect
// rectangle that fits the source, so only its *center* pans along the one free
// axis (the other is pinned). We pick a subject per frame (face first, else
// person), track it so the target doesn't flip between people, hold position on
// gaps (never lurch), smooth within a shot, hard-cut across scene changes, and
// simplify to a compact set of control points.

import type { Detection, SubjectFrame } from "./ipc";

/** A crop-window center at time `t`, in normalized source coords (0-1). */
export interface CropPoint {
  t: number;
  cx: number;
  cy: number;
}

/** The panning crop window: normalized size + which axis is free to move. */
export interface CropWindow {
  winW: number;
  winH: number;
  freeAxis: "x" | "y" | "none";
}

/** A built crop path: the (fixed) window size plus its center over time. */
export interface CropPath {
  winW: number;
  winH: number;
  points: CropPoint[];
}

/** Options for {@link buildCropPath}; all have sensible defaults. */
export interface PathOptions {
  /** Scene-cut times (seconds); the path hard-cuts (re-snaps) at each. */
  sceneCuts?: number[];
  /** EMA smoothing factor (0-1); lower = smoother/laggier. */
  alpha?: number;
  /** Douglas-Peucker tolerance (normalized) for control-point thinning. */
  epsilon?: number;
}

const boxCenter = (d: Detection): { cx: number; cy: number } => ({
  cx: (d.x1 + d.x2) / 2,
  cy: (d.y1 + d.y2) / 2,
});

/**
 * Per-detection salience for subject arbitration. A plain `score·√area` lets a
 * big low-confidence decoy (the person model emits large spurious blobs) outrank
 * a confident, centrally-framed subject. Instead this weights four things:
 *
 * - **confidence** — the detection's probability (the score is a real 0–1
 *   probability now the decode's redundant sigmoid is gone), with a `0.3` floor
 *   so a weak-but-correct box still counts;
 * - **area**, softened to a fourth root so size helps but never dominates;
 * - **centrality** — subjects are usually framed near center, so edge decoys
 *   are penalized;
 * - **aspect** — a person box is taller than it is wide; squat blobs are demoted.
 */
const salience = (d: Detection): number => {
  const w = Math.max(0, d.x2 - d.x1);
  const h = Math.max(0, d.y2 - d.y1);
  const areaTerm = Math.pow(w * h, 0.25);
  const cx = (d.x1 + d.x2) / 2;
  const centrality = 1 - Math.min(1, Math.abs(cx - 0.5) / 0.5) * 0.6;
  const aspect = h >= w ? 1 : 0.6;
  return (0.3 + d.score) * areaTerm * centrality * aspect;
};

// How strongly proximity to the previously-tracked center is preferred over
// raw salience, so the target sticks to one subject instead of flipping.
const TRACK_LAMBDA = 1.5;

const dist = (
  a: { cx: number; cy: number },
  b: { cx: number; cy: number },
): number => Math.hypot(a.cx - b.cx, a.cy - b.cy);

/**
 * The panning crop window for a source/canvas aspect pair. If the canvas is
 * narrower than the source the window is full-height and pans horizontally; if
 * taller, full-width and pans vertically; if they match, no panning.
 */
export function cropWindow(sourceAr: number, canvasAr: number): CropWindow {
  if (Math.abs(sourceAr - canvasAr) < 1e-4) {
    return { winW: 1, winH: 1, freeAxis: "none" };
  }
  if (canvasAr < sourceAr) {
    return { winW: canvasAr / sourceAr, winH: 1, freeAxis: "x" };
  }
  return { winW: 1, winH: sourceAr / canvasAr, freeAxis: "y" };
}

/**
 * Choose the subject to track in one frame: prefer faces (already
 * confidence-thresholded in the backend) over persons. With a previous center,
 * balance salience against proximity to it (the tracker); without one, take the
 * most salient. Returns `null` when there's nothing to track.
 */
export function selectSubject(
  frame: SubjectFrame,
  prev: { cx: number; cy: number } | null,
): Detection | null {
  const pool = frame.faces.length ? frame.faces : frame.persons;
  if (!pool.length) return null;
  const rank = prev
    ? (d: Detection) => salience(d) - TRACK_LAMBDA * dist(boxCenter(d), prev)
    : (d: Detection) => salience(d);
  return pool.reduce((best, d) => (rank(d) > rank(best) ? d : best));
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

/** Clamp a center so the crop window stays fully inside the source frame. */
function clampCenter(cx: number, cy: number, win: CropWindow): CropPoint {
  const hx = win.winW / 2;
  const hy = win.winH / 2;
  // Only the free axis moves; the other is pinned to the frame center.
  return {
    t: 0,
    cx: win.freeAxis === "x" ? clamp(cx, hx, 1 - hx) : 0.5,
    cy: win.freeAxis === "y" ? clamp(cy, hy, 1 - hy) : 0.5,
  };
}

/**
 * Raw per-frame crop centers: select + track a subject each frame, clamp it into
 * the window, and hold the last center when a frame has no subject (so a
 * detection gap glides instead of snapping to center). Both axes are returned
 * but only the free one varies.
 *
 * The tracker resets at each scene cut: a hard cut invalidates the previous
 * subject's position, so proximity to it is meaningless. Without the reset the
 * tracker can lock onto a decoy detected just before a cut and then keep
 * preferring it (its proximity term) over the real subject after the cut. On the
 * first frame of a new shot we re-select by pure salience instead.
 */
export function buildRawCenters(
  frames: SubjectFrame[],
  win: CropWindow,
  sceneCuts: number[] = [],
): CropPoint[] {
  const out: CropPoint[] = [];
  const cuts = [...sceneCuts].sort((a, b) => a - b);
  let cutIdx = 0;
  let prev: { cx: number; cy: number } | null = null;
  let held: CropPoint = clampCenter(0.5, 0.5, win); // default: centered
  for (const frame of frames) {
    // Drop the tracker's memory when this frame opens a new shot.
    while (cutIdx < cuts.length && frame.t >= cuts[cutIdx]) {
      cutIdx += 1;
      prev = null;
    }
    const subject = selectSubject(frame, prev);
    if (subject) {
      const c = boxCenter(subject);
      held = clampCenter(c.cx, c.cy, win);
      prev = { cx: held.cx, cy: held.cy };
    }
    out.push({ t: frame.t, cx: held.cx, cy: held.cy });
  }
  return out;
}

/**
 * Median-despike the free axis within each shot: replace each point with the
 * median of a small window. This kills isolated 1-2 frame excursions — a decoy
 * that briefly outranks the subject for a frame, then loses again — which a mean
 * filter would instead smear into a visible wander. Sustained motion passes
 * through untouched. Reset at scene cuts so a window never straddles a hard cut.
 */
export function medianDespike(
  points: CropPoint[],
  sceneCuts: number[],
  freeAxis: "x" | "y" | "none",
  window = 3,
): CropPoint[] {
  if (freeAxis === "none" || points.length === 0) return points.slice();
  const key = freeAxis === "x" ? "cx" : "cy";
  const cuts = [...sceneCuts].sort((a, b) => a - b);
  const out = points.map((p) => ({ ...p }));
  const k = (window - 1) >> 1;
  const filterSeg = (lo: number, hi: number) => {
    const vals = points.slice(lo, hi).map((p) => p[key]);
    for (let i = 0; i < vals.length; i++) {
      const win = vals
        .slice(Math.max(0, i - k), Math.min(vals.length, i + k + 1))
        .sort((a, b) => a - b);
      out[lo + i][key] = win[win.length >> 1];
    }
  };
  // Segment into shots, median-filter each independently.
  let segStart = 0;
  let cutIdx = 0;
  for (let i = 0; i < points.length; i++) {
    let cut = false;
    while (cutIdx < cuts.length && points[i].t >= cuts[cutIdx]) {
      cutIdx += 1;
      cut = true;
    }
    if (cut && i > segStart) {
      filterSeg(segStart, i);
      segStart = i;
    }
  }
  filterSeg(segStart, points.length);
  return out;
}

/**
 * Zero-phase (forward-backward) EMA smoothing of one shot's free-axis values
 * in place. A one-pass EMA only ever trails its input, so at 3 fps a smoothing
 * factor low enough to be steady lags the subject by ~2 s — the crop visibly
 * chases the subject instead of framing it. Path building is offline (the whole
 * detection sequence is known up front), so we filter forward then backward over
 * the result: the two passes' phase lags cancel, leaving a smooth path with no
 * net delay. Applied per shot so a scene cut isn't smeared across.
 */
function smoothSegment(
  out: CropPoint[],
  start: number,
  end: number,
  key: "cx" | "cy",
  alpha: number,
): void {
  const n = end - start;
  if (n <= 1) return;
  const raw = out.slice(start, end).map((p) => p[key]);
  const fwd = new Array<number>(n);
  fwd[0] = raw[0];
  for (let i = 1; i < n; i++) fwd[i] = alpha * raw[i] + (1 - alpha) * fwd[i - 1];
  const res = new Array<number>(n);
  res[n - 1] = fwd[n - 1];
  for (let i = n - 2; i >= 0; i--) {
    res[i] = alpha * fwd[i] + (1 - alpha) * res[i + 1];
  }
  for (let i = 0; i < n; i++) out[start + i][key] = res[i];
}

/**
 * Smooth the free axis with a zero-phase EMA, restarted (hard cut) at each scene
 * boundary so a pan doesn't smear a shot change. `sceneCuts` are ascending times;
 * a point at/after the next cut opens a new shot, smoothed independently.
 */
export function smooth(
  points: CropPoint[],
  sceneCuts: number[],
  alpha: number,
  freeAxis: "x" | "y" | "none",
): CropPoint[] {
  if (freeAxis === "none" || points.length === 0) return points.slice();
  const key = freeAxis === "x" ? "cx" : "cy";
  const cuts = [...sceneCuts].sort((a, b) => a - b);
  const out = points.map((p) => ({ ...p }));
  // Smooth each shot [segStart, i) independently, breaking at every scene cut.
  let segStart = 0;
  let cutIdx = 0;
  for (let i = 0; i < out.length; i++) {
    let cut = false;
    while (cutIdx < cuts.length && out[i].t >= cuts[cutIdx]) {
      cutIdx += 1;
      cut = true;
    }
    if (cut && i > segStart) {
      smoothSegment(out, segStart, i, key, alpha);
      segStart = i;
    }
  }
  smoothSegment(out, segStart, out.length, key, alpha);
  return out;
}

/** Perpendicular distance from point `p` to the segment `a`-`b` in (t, v) space. */
function perpDist(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): number {
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return Math.hypot(p[0] - ax, p[1] - ay);
  // |cross product| / |segment length|.
  return Math.abs((p[0] - ax) * dy - (p[1] - ay) * dx) / len;
}

/**
 * Douglas-Peucker simplification of the free-axis path in (t, value) space,
 * thinning the per-frame points to a compact set of control points (endpoints
 * always kept) so the backend's `crop` expression stays small.
 */
export function simplify(
  points: CropPoint[],
  epsilon: number,
  freeAxis: "x" | "y" | "none",
): CropPoint[] {
  if (freeAxis === "none" || points.length <= 2) return points.slice();
  const key = freeAxis === "x" ? "cx" : "cy";
  const pts: [number, number][] = points.map((p) => [p.t, p[key]]);

  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    let maxD = -1;
    let idx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDist(pts[i], pts[lo], pts[hi]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > epsilon && idx !== -1) {
      keep[idx] = true;
      stack.push([lo, idx], [idx, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Sample the crop center at time `t` by linear interpolation between control
 * points, holding the ends. Drives the live preview overlay; `points` times are
 * whatever space the caller built them in (the preview uses absolute video time).
 */
export function sampleCenter(
  points: CropPoint[],
  t: number,
): { cx: number; cy: number } {
  if (points.length === 0) return { cx: 0.5, cy: 0.5 };
  const first = points[0];
  const last = points[points.length - 1];
  if (t <= first.t) return { cx: first.cx, cy: first.cy };
  if (t >= last.t) return { cx: last.cx, cy: last.cy };
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (t >= a.t && t <= b.t) {
      const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
      return { cx: a.cx + (b.cx - a.cx) * f, cy: a.cy + (b.cy - a.cy) * f };
    }
  }
  return { cx: last.cx, cy: last.cy };
}

/**
 * Build the full crop path for a set of per-frame detections against a target
 * canvas: window → tracked raw centers → smoothed (scene-cut aware) → simplified
 * control points. Returns `null` if there are no frames.
 */
export function buildCropPath(
  frames: SubjectFrame[],
  sourceAr: number,
  canvasAr: number,
  opts: PathOptions = {},
): CropPath | null {
  if (frames.length === 0) return null;
  const win = cropWindow(sourceAr, canvasAr);
  const cuts = opts.sceneCuts ?? [];
  const raw = buildRawCenters(frames, win, cuts);
  // Despike single-frame decoy grabs, then zero-phase smooth. 0.4 slides quickly
  // enough to keep up with a fast subject move (the filter has no lag; a lower
  // value just attenuates the move so the crop appears to trail), while the
  // despike + clean detections keep it steady when the subject is still.
  const despiked = medianDespike(raw, cuts, win.freeAxis);
  const smoothed = smooth(despiked, cuts, opts.alpha ?? 0.4, win.freeAxis);
  const points = simplify(smoothed, opts.epsilon ?? 0.005, win.freeAxis);
  return { winW: win.winW, winH: win.winH, points };
}

/** A user "drag to fix" correction: at time `t`, the crop center should be here. */
export interface Correction {
  t: number;
  cx: number;
  cy: number;
}

/** Ease window (seconds) either side of a correction over which it blends to auto. */
export const CORRECTION_EASE = 1.0;

/** Smooth bump kernel: 1 at the correction, 0 at ±`ease`, C¹-continuous between. */
function correctionWeight(dt: number, ease: number): number {
  const d = Math.abs(dt) / ease;
  if (d >= 1) return 0;
  const b = 1 - d * d;
  return b * b;
}

/**
 * Sample the auto center at `t` with user corrections applied ("drag to fix, auto
 * eases back"). Each correction contributes an offset from the auto track that
 * peaks at its own time and fades to zero `ease` seconds away, so the path passes
 * through the correction and smoothly rejoins auto on either side. Corrections and
 * `path` must share a time base (both absolute, or both trim-relative).
 */
export function correctedCenter(
  path: CropPath,
  corrections: Correction[],
  t: number,
  ease = CORRECTION_EASE,
): { cx: number; cy: number } {
  const auto = sampleCenter(path.points, t);
  let ox = 0;
  let oy = 0;
  for (const c of corrections) {
    const w = correctionWeight(t - c.t, ease);
    if (w === 0) continue;
    const at = sampleCenter(path.points, c.t);
    ox += (c.cx - at.cx) * w;
    oy += (c.cy - at.cy) * w;
  }
  return { cx: auto.cx + ox, cy: auto.cy + oy };
}

/**
 * Bake corrections into a crop path's control points: resample the corrected
 * center densely around each correction (to capture the eased bump) plus at the
 * existing control points, then re-simplify. Used to build the export path so it
 * matches the corrected preview. Returns `path` unchanged when there are no
 * corrections.
 */
export function applyCorrections(
  path: CropPath,
  corrections: Correction[],
  freeAxis: "x" | "y" | "none",
  ease = CORRECTION_EASE,
  epsilon = 0.005,
): CropPath {
  if (corrections.length === 0 || path.points.length === 0) return path;
  const first = path.points[0].t;
  const last = path.points[path.points.length - 1].t;
  // Sample times: existing control points + a fan around each correction so the
  // bump isn't simplified away.
  const times = new Set<number>(path.points.map((p) => p.t));
  for (const c of corrections) {
    for (let k = -4; k <= 4; k++) times.add(c.t + (k / 4) * ease);
  }
  const sorted = [...times]
    .filter((t) => t >= first && t <= last)
    .sort((a, b) => a - b);
  const resampled: CropPoint[] = sorted.map((t) => ({
    t,
    ...correctedCenter(path, corrections, t, ease),
  }));
  return {
    winW: path.winW,
    winH: path.winH,
    points: simplify(resampled, epsilon, freeAxis),
  };
}
