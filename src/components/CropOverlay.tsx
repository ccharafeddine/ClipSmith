import { Show } from "solid-js";
import { cropAspectLock, cropMode, cropRect, meta, setCropRect } from "../state";
import { lockedCropResize, type CropHandle } from "../reframe";

// Draggable / resizable crop rectangle laid over the video stage. The rectangle
// is stored in source pixels (state.cropRect); this component maps between those
// and the on-screen overlay size so the crop stays correct regardless of how the
// video is scaled in the window (including when a downscaled playback proxy is
// shown — crop coordinates are always in true source pixels via meta()).

type Handle = "move" | "nw" | "ne" | "sw" | "se";

const clamp = (x: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, x));

// Smallest crop, in source pixels, on either axis.
const MIN_SIZE = 16;

export default function CropOverlay() {
  let overlay: HTMLDivElement | undefined;

  const srcW = () => meta()?.width ?? 1;
  const srcH = () => meta()?.height ?? 1;

  function startDrag(handle: Handle, e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const start = cropRect();
    if (!start || !overlay) return;

    const rect = overlay.getBoundingClientRect();
    // Source pixels travelled per screen pixel of pointer movement.
    const perX = srcW() / rect.width;
    const perY = srcH() / rect.height;
    const ox = e.clientX;
    const oy = e.clientY;
    // Captured once per drag: the aspect the box is locked to (manual
    // crop-to-fill), or null for the unconstrained freeform crop.
    const lockedAr = cropAspectLock();

    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - ox) * perX;
      const dy = (ev.clientY - oy) * perY;

      if (handle === "move") {
        const x = clamp(start.x + dx, 0, srcW() - start.w);
        const y = clamp(start.y + dy, 0, srcH() - start.h);
        setCropRect({ x: Math.round(x), y: Math.round(y), w: start.w, h: start.h });
        return;
      }

      if (lockedAr !== null) {
        // Aspect-locked corner resize (manual crop-to-fill); pure math lives in
        // reframe.ts so it's unit-tested. `handle` is a corner here (the "move"
        // case returned above).
        setCropRect(
          lockedCropResize(
            handle as CropHandle,
            start,
            dx,
            dy,
            srcW(),
            srcH(),
            lockedAr,
            MIN_SIZE,
          ),
        );
        return;
      }

      // Free resize (freeform crop): each edge moves independently.
      let left = start.x;
      let top = start.y;
      let right = start.x + start.w;
      let bottom = start.y + start.h;
      if (handle.includes("w")) left = clamp(start.x + dx, 0, right - MIN_SIZE);
      if (handle.includes("e"))
        right = clamp(start.x + start.w + dx, left + MIN_SIZE, srcW());
      if (handle.includes("n")) top = clamp(start.y + dy, 0, bottom - MIN_SIZE);
      if (handle.includes("s"))
        bottom = clamp(start.y + start.h + dy, top + MIN_SIZE, srcH());

      setCropRect({
        x: Math.round(left),
        y: Math.round(top),
        w: Math.round(right - left),
        h: Math.round(bottom - top),
      });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // The box position/size as percentages of the source frame (== overlay).
  const box = () => {
    const c = cropRect();
    if (!c) return null;
    return {
      left: `${(c.x / srcW()) * 100}%`,
      top: `${(c.y / srcH()) * 100}%`,
      width: `${(c.w / srcW()) * 100}%`,
      height: `${(c.h / srcH()) * 100}%`,
    };
  };

  return (
    <Show when={cropMode() && cropRect()}>
      <div class="crop-overlay" ref={overlay}>
        <div
          class="crop-box"
          style={box() ?? {}}
          onPointerDown={(e) => startDrag("move", e)}
        >
          <div
            class="crop-handle crop-nw"
            onPointerDown={(e) => startDrag("nw", e)}
          />
          <div
            class="crop-handle crop-ne"
            onPointerDown={(e) => startDrag("ne", e)}
          />
          <div
            class="crop-handle crop-sw"
            onPointerDown={(e) => startDrag("sw", e)}
          />
          <div
            class="crop-handle crop-se"
            onPointerDown={(e) => startDrag("se", e)}
          />
        </div>
      </div>
    </Show>
  );
}
