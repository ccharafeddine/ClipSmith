import { For } from "solid-js";
import {
  currentTime,
  duration,
  inPoint,
  keyframes,
  MIN_CLIP,
  outPoint,
  seekTo,
  setInPoint,
  setOutPoint,
  snapIn,
} from "../state";

// Trim timeline: keyframe ticks, the selected range, a playhead, and two
// draggable handles. IN is magnetic (snaps to the nearest keyframe at or
// before its position); OUT is free. Clicking the track scrubs the playhead.
export default function Timeline() {
  let trackEl: HTMLDivElement | undefined;

  /** Position of time `t` as a percentage of the track width. */
  function pct(t: number): number {
    const d = duration();
    if (d <= 0) return 0;
    return Math.min(Math.max(t / d, 0), 1) * 100;
  }

  /** Convert a clientX pixel to a time within [0, duration]. */
  function pxToTime(clientX: number): number {
    if (!trackEl) return 0;
    const rect = trackEl.getBoundingClientRect();
    const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    return Math.min(Math.max(ratio, 0), 1) * duration();
  }

  /** Attach window listeners that call `onMove` until the pointer is released. */
  function beginDrag(onMove: (clientX: number) => void) {
    const move = (ev: PointerEvent) => onMove(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function applyIn(clientX: number) {
    // Keep IN strictly before OUT, then snap to a keyframe at or before it.
    const limit = Math.max(0, outPoint() - MIN_CLIP);
    const snapped = snapIn(Math.min(pxToTime(clientX), limit), keyframes());
    setInPoint(snapped);
    seekTo(snapped);
  }

  function applyOut(clientX: number) {
    const lo = inPoint() + MIN_CLIP;
    const clamped = Math.min(Math.max(pxToTime(clientX), lo), duration());
    setOutPoint(clamped);
    seekTo(clamped);
  }

  function startIn(e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    applyIn(e.clientX);
    beginDrag(applyIn);
  }

  function startOut(e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    applyOut(e.clientX);
    beginDrag(applyOut);
  }

  function startScrub(e: PointerEvent) {
    e.preventDefault();
    seekTo(pxToTime(e.clientX));
    beginDrag((clientX) => seekTo(pxToTime(clientX)));
  }

  return (
    <div class="tl" ref={trackEl} onPointerDown={startScrub}>
      <div class="tl-track" />

      <For each={keyframes()}>
        {(kf) => (
          <div class="tl-tick" style={{ left: `${pct(kf)}%` }} />
        )}
      </For>

      <div
        class="tl-range"
        style={{
          left: `${pct(inPoint())}%`,
          width: `${Math.max(0, pct(outPoint()) - pct(inPoint()))}%`,
        }}
      />

      <div class="tl-playhead" style={{ left: `${pct(currentTime())}%` }} />

      <div
        class="tl-handle tl-handle-in"
        style={{ left: `${pct(inPoint())}%` }}
        onPointerDown={startIn}
        role="slider"
        aria-label="Clip start"
        aria-valuenow={inPoint()}
      />
      <div
        class="tl-handle tl-handle-out"
        style={{ left: `${pct(outPoint())}%` }}
        onPointerDown={startOut}
        role="slider"
        aria-label="Clip end"
        aria-valuenow={outPoint()}
      />
    </div>
  );
}
