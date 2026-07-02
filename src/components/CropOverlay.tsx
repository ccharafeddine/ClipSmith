import { Show } from "solid-js";
import { cropAspectLock, cropMode, cropRect, meta, setCropRect } from "../state";

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

      const sLeft = start.x;
      const sTop = start.y;
      const sRight = start.x + start.w;
      const sBottom = start.y + start.h;

      if (lockedAr !== null) {
        // Aspect-locked corner resize: the opposite corner stays pinned; the box
        // tracks whichever axis the pointer moved farther, height following width.
        const anchorX = handle.includes("w") ? sRight : sLeft;
        const anchorY = handle.includes("n") ? sBottom : sTop;
        const targetX = clamp((handle.includes("w") ? sLeft : sRight) + dx, 0, srcW());
        const targetY = clamp((handle.includes("n") ? sTop : sBottom) + dy, 0, srcH());
        const availW = handle.includes("w") ? anchorX : srcW() - anchorX;
        const availH = handle.includes("n") ? anchorY : srcH() - anchorY;

        const minW = Math.max(MIN_SIZE, MIN_SIZE * lockedAr);
        let w = clamp(
          Math.max(Math.abs(targetX - anchorX), Math.abs(targetY - anchorY) * lockedAr),
          minW,
          availW,
        );
        let h = w / lockedAr;
        if (h > availH) {
          h = availH;
          w = h * lockedAr;
        }
        const left = handle.includes("w") ? anchorX - w : anchorX;
        const top = handle.includes("n") ? anchorY - h : anchorY;
        setCropRect({
          x: Math.round(left),
          y: Math.round(top),
          w: Math.round(w),
          h: Math.round(h),
        });
        return;
      }

      // Free resize (freeform crop): each edge moves independently.
      let left = sLeft;
      let top = sTop;
      let right = sRight;
      let bottom = sBottom;
      if (handle.includes("w")) left = clamp(sLeft + dx, 0, right - MIN_SIZE);
      if (handle.includes("e")) right = clamp(sRight + dx, left + MIN_SIZE, srcW());
      if (handle.includes("n")) top = clamp(sTop + dy, 0, bottom - MIN_SIZE);
      if (handle.includes("s")) bottom = clamp(sBottom + dy, top + MIN_SIZE, srcH());

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
