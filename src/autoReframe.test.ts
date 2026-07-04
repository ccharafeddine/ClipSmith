import { describe, it, expect } from "vitest";
import {
  buildCropPath,
  buildRawCenters,
  cropWindow,
  sampleCenter,
  selectSubject,
  simplify,
  smooth,
  type CropPoint,
} from "./autoReframe";
import type { Detection, SubjectFrame } from "./ipc";

const det = (
  cx: number,
  cy: number,
  size: number,
  score: number,
): Detection => ({
  x1: cx - size / 2,
  y1: cy - size / 2,
  x2: cx + size / 2,
  y2: cy + size / 2,
  score,
});

const frame = (
  t: number,
  faces: Detection[],
  persons: Detection[] = [],
): SubjectFrame => ({ t, faces, persons });

describe("cropWindow", () => {
  it("portrait canvas in a landscape source pans horizontally", () => {
    const w = cropWindow(16 / 9, 9 / 16);
    expect(w.freeAxis).toBe("x");
    expect(w.winH).toBe(1);
    expect(w.winW).toBeCloseTo(9 / 16 / (16 / 9), 4); // ~0.316
  });

  it("landscape canvas in a portrait source pans vertically", () => {
    const w = cropWindow(9 / 16, 16 / 9);
    expect(w.freeAxis).toBe("y");
    expect(w.winW).toBe(1);
    expect(w.winH).toBeCloseTo(9 / 16 / (16 / 9), 4);
  });

  it("matching aspects need no panning", () => {
    const w = cropWindow(1, 1);
    expect(w.freeAxis).toBe("none");
    expect(w.winW).toBe(1);
    expect(w.winH).toBe(1);
  });
});

describe("selectSubject", () => {
  it("prefers a face over a person", () => {
    const f = frame(0, [det(0.3, 0.5, 0.1, 0.9)], [det(0.7, 0.5, 0.4, 0.9)]);
    const s = selectSubject(f, null);
    expect(s).not.toBeNull();
    // Face center is ~0.3, not the (bigger) person at 0.7.
    expect((s!.x1 + s!.x2) / 2).toBeCloseTo(0.3, 5);
  });

  it("takes the most salient when there's no prior", () => {
    // Bigger, equally-confident person wins.
    const f = frame(0, [], [det(0.2, 0.5, 0.1, 0.8), det(0.8, 0.5, 0.4, 0.8)]);
    const s = selectSubject(f, null);
    expect((s!.x1 + s!.x2) / 2).toBeCloseTo(0.8, 5);
  });

  it("sticks to the nearer subject when tracking", () => {
    // Two similar persons; prev center is near the left one, so it wins even
    // though the right one is marginally more salient.
    const f = frame(0, [], [det(0.25, 0.5, 0.2, 0.8), det(0.75, 0.5, 0.22, 0.82)]);
    const s = selectSubject(f, { cx: 0.25, cy: 0.5 });
    expect((s!.x1 + s!.x2) / 2).toBeCloseTo(0.25, 5);
  });

  it("returns null when nothing is detected", () => {
    expect(selectSubject(frame(0, [], []), null)).toBeNull();
  });
});

describe("buildRawCenters", () => {
  const win = cropWindow(16 / 9, 9 / 16); // pan x, winW ~0.316

  it("clamps the center so the window stays inside the frame", () => {
    // Subject hard against the right edge; center can't exceed 1 - winW/2.
    const pts = buildRawCenters([frame(0, [det(0.98, 0.5, 0.05, 0.9)])], win);
    expect(pts[0].cx).toBeCloseTo(1 - win.winW / 2, 5);
    expect(pts[0].cy).toBe(0.5); // pinned axis
  });

  it("holds the last center across a detection gap", () => {
    const pts = buildRawCenters(
      [
        frame(0, [det(0.3, 0.5, 0.1, 0.9)]),
        frame(1, [], []), // gap → hold
        frame(2, [], []),
      ],
      win,
    );
    expect(pts[1].cx).toBeCloseTo(pts[0].cx, 5);
    expect(pts[2].cx).toBeCloseTo(pts[0].cx, 5);
  });
});

describe("smooth", () => {
  const jitter: CropPoint[] = Array.from({ length: 10 }, (_, i) => ({
    t: i,
    cx: i % 2 === 0 ? 0.4 : 0.6, // alternating jitter
    cy: 0.5,
  }));

  it("reduces jitter on the free axis", () => {
    const out = smooth(jitter, [], 0.2, "x");
    const spread = (a: CropPoint[]) =>
      Math.max(...a.map((p) => p.cx)) - Math.min(...a.map((p) => p.cx));
    // Smoothed range is much tighter than the raw 0.2 swing.
    expect(spread(out.slice(3))).toBeLessThan(0.15);
  });

  it("hard-cuts (re-snaps) at a scene boundary", () => {
    const pts: CropPoint[] = [
      { t: 0, cx: 0.2, cy: 0.5 },
      { t: 1, cx: 0.2, cy: 0.5 },
      { t: 2, cx: 0.8, cy: 0.5 }, // new shot starts here
      { t: 3, cx: 0.8, cy: 0.5 },
    ];
    const out = smooth(pts, [2], 0.2, "x");
    // Without a cut, EMA at t=2 would still be near 0.2; the cut snaps it to 0.8.
    expect(out[2].cx).toBeCloseTo(0.8, 5);
  });
});

describe("simplify (Douglas-Peucker)", () => {
  it("reduces a straight ramp to its endpoints", () => {
    const line: CropPoint[] = Array.from({ length: 11 }, (_, i) => ({
      t: i,
      cx: 0.2 + i * 0.05, // perfectly linear
      cy: 0.5,
    }));
    expect(simplify(line, 0.005, "x")).toHaveLength(2);
  });

  it("keeps a point that deviates beyond the tolerance", () => {
    const pts: CropPoint[] = [
      { t: 0, cx: 0.2, cy: 0.5 },
      { t: 1, cx: 0.5, cy: 0.5 }, // spike well off the 0.2->0.2 line
      { t: 2, cx: 0.2, cy: 0.5 },
    ];
    expect(simplify(pts, 0.01, "x")).toHaveLength(3);
  });
});

describe("sampleCenter", () => {
  const pts: CropPoint[] = [
    { t: 0, cx: 0.2, cy: 0.5 },
    { t: 2, cx: 0.6, cy: 0.5 },
  ];

  it("interpolates linearly between control points", () => {
    expect(sampleCenter(pts, 1).cx).toBeCloseTo(0.4, 6); // halfway
    expect(sampleCenter(pts, 0.5).cx).toBeCloseTo(0.3, 6);
  });

  it("holds the ends outside the range", () => {
    expect(sampleCenter(pts, -5).cx).toBe(0.2);
    expect(sampleCenter(pts, 99).cx).toBe(0.6);
  });

  it("defaults to center with no points", () => {
    expect(sampleCenter([], 1)).toEqual({ cx: 0.5, cy: 0.5 });
  });
});

describe("buildCropPath", () => {
  it("builds a compact path from a detection sequence", () => {
    const frames: SubjectFrame[] = Array.from({ length: 30 }, (_, i) => {
      const t = i / 3;
      // Subject drifts smoothly left→right.
      const cx = 0.3 + (i / 30) * 0.4;
      return frame(t, [det(cx, 0.5, 0.1, 0.9)]);
    });
    const path = buildCropPath(frames, 16 / 9, 9 / 16);
    expect(path).not.toBeNull();
    expect(path!.winH).toBe(1);
    // A near-linear drift simplifies to far fewer points than the 30 frames.
    expect(path!.points.length).toBeGreaterThanOrEqual(2);
    expect(path!.points.length).toBeLessThan(30);
    // Centers stay within the valid pan range.
    for (const p of path!.points) {
      expect(p.cx).toBeGreaterThanOrEqual(path!.winW / 2 - 1e-6);
      expect(p.cx).toBeLessThanOrEqual(1 - path!.winW / 2 + 1e-6);
    }
  });

  it("returns null with no frames", () => {
    expect(buildCropPath([], 16 / 9, 9 / 16)).toBeNull();
  });
});
