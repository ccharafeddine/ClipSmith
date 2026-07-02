import { describe, it, expect } from "vitest";
import {
  canvasDims,
  ratioValue,
  isPreset,
  barsAxis,
  anchorObjectPosition,
  lockedCropResize,
  type CropHandle,
} from "./reframe";
import type { CropRect } from "./ipc";

describe("ratioValue / isPreset", () => {
  it("maps presets to numbers and original/freeform to null", () => {
    expect(ratioValue("9:16")).toBeCloseTo(9 / 16);
    expect(ratioValue("1:1")).toBe(1);
    expect(ratioValue("16:9")).toBeCloseTo(16 / 9);
    expect(ratioValue("original")).toBeNull();
    expect(ratioValue("freeform")).toBeNull();
    expect(isPreset("4:5")).toBe(true);
    expect(isPreset("original")).toBe(false);
    expect(isPreset("freeform")).toBe(false);
  });
});

describe("canvasDims (no-upscale rule, even dims)", () => {
  const even = (n: number) => n % 2 === 0;

  it("landscape source into a portrait canvas is height-locked", () => {
    const [w, h] = canvasDims("9:16", 1920, 1080);
    expect(h).toBe(1080); // locked to source height
    expect(w / h).toBeCloseTo(9 / 16, 2);
    expect(w).toBeLessThanOrEqual(1920); // never exceeds source width
    expect(even(w) && even(h)).toBe(true);
  });

  it("portrait source into a landscape canvas is width-locked", () => {
    const [w, h] = canvasDims("16:9", 1080, 1920);
    expect(w).toBe(1080); // locked to source width
    expect(w / h).toBeCloseTo(16 / 9, 2);
    expect(h).toBeLessThanOrEqual(1920);
    expect(even(w) && even(h)).toBe(true);
  });

  it("square canvas fits inside the source", () => {
    expect(canvasDims("1:1", 1920, 1080)).toEqual([1080, 1080]);
  });

  it("original/freeform return the (evened) source size", () => {
    expect(canvasDims("original", 1921, 1081)).toEqual([1920, 1080]);
    expect(canvasDims("freeform", 640, 480)).toEqual([640, 480]);
  });

  it("degrades safely on a zero-height source", () => {
    const [w, h] = canvasDims("16:9", 0, 0);
    expect(w).toBeGreaterThanOrEqual(2);
    expect(h).toBeGreaterThanOrEqual(2);
  });
});

describe("barsAxis", () => {
  it("wider-than-canvas source → vertical bars (top/bottom)", () => {
    expect(barsAxis("9:16", 1920, 1080)).toBe("vertical");
  });
  it("taller-than-canvas source → horizontal bars (left/right)", () => {
    expect(barsAxis("16:9", 1080, 1920)).toBe("horizontal");
  });
  it("matching aspect → no bars", () => {
    expect(barsAxis("16:9", 1920, 1080)).toBeNull();
    expect(barsAxis("original", 1920, 1080)).toBeNull();
  });
});

describe("anchorObjectPosition", () => {
  it("vertical bars move the frame up/down", () => {
    expect(anchorObjectPosition("start", "vertical")).toBe("center top");
    expect(anchorObjectPosition("end", "vertical")).toBe("center bottom");
    expect(anchorObjectPosition("center", "vertical")).toBe("center center");
  });
  it("horizontal bars move the frame left/right", () => {
    expect(anchorObjectPosition("start", "horizontal")).toBe("left center");
    expect(anchorObjectPosition("end", "horizontal")).toBe("right center");
  });
  it("no bars → centered", () => {
    expect(anchorObjectPosition("start", null)).toBe("center center");
  });
});

describe("lockedCropResize", () => {
  const rect = (x: number, y: number, w: number, h: number): CropRect => ({ x, y, w, h });

  it("preserves the aspect ratio and pins the opposite corner", () => {
    const start = rect(100, 100, 200, 100); // 2:1
    const out = lockedCropResize("se", start, 100, 0, 1000, 1000, 2, 16);
    expect(out.x).toBe(100); // nw corner pinned
    expect(out.y).toBe(100);
    expect(out.w / out.h).toBeCloseTo(2, 5);
    expect(out.w).toBeGreaterThan(start.w); // grew
  });

  it("stays within the source frame", () => {
    const start = rect(100, 100, 200, 100);
    const out = lockedCropResize("se", start, 5000, 5000, 1000, 1000, 2, 16);
    expect(out.x + out.w).toBeLessThanOrEqual(1000);
    expect(out.y + out.h).toBeLessThanOrEqual(1000);
    expect(out.w / out.h).toBeCloseTo(2, 5);
  });

  it("returns the start rect unchanged when the pinned corner can't fit the minimum", () => {
    const start = rect(995, 100, 3, 3); // nw pinned at x=995, only 5px to the right edge
    const out = lockedCropResize("se", start, 100, 100, 1000, 1000, 1, 16);
    expect(out).toEqual(start);
  });

  it("never produces a negative or zero-size rect", () => {
    const handles: CropHandle[] = ["nw", "ne", "sw", "se"];
    for (const h of handles) {
      const out = lockedCropResize(h, rect(400, 400, 200, 200), -50, -50, 1000, 1000, 1, 16);
      expect(out.w).toBeGreaterThan(0);
      expect(out.h).toBeGreaterThan(0);
      expect(out.x).toBeGreaterThanOrEqual(0);
      expect(out.y).toBeGreaterThanOrEqual(0);
    }
  });
});
