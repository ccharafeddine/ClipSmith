import { createMemo, For, Show } from "solid-js";
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
  setViewEnd,
  setViewStart,
  snapIn,
  viewEnd,
  viewStart,
} from "../state";
import { formatDuration } from "../format";

// Most-zoomed-in state: the window can shrink to this many seconds. Kept small
// so the free OUT handle (and the magnetic IN handle near sparse keyframes) can
// be placed precisely for accurate trimming.
const MIN_VIEW_SPAN = 1;
// Wheel zoom step per notch.
const ZOOM_FACTOR = 1.2;

const clamp = (x: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, x));

type DragKind = "in" | "out" | "playhead";

// iOS-style trim strip with a zoomable view window. Drag the IN/OUT handles to
// frame the clip; drag elsewhere to scrub. Scroll to zoom the visible window
// (cursor-anchored, down to MIN_VIEW_SPAN). The IN handle is magnetic — it snaps
// to the nearest keyframe at or before it, since `-c copy` must start on a
// keyframe — while the OUT handle is free. Keyframe positions show as ticks.
export default function Timeline() {
  let track: HTMLDivElement | undefined;

  const viewSpan = () => viewEnd() - viewStart();

  // Position of a time within the visible window, as a clamped 0-100 percentage.
  const pct = (t: number) => {
    const span = viewSpan();
    return span > 0 ? clamp(((t - viewStart()) / span) * 100, 0, 100) : 0;
  };

  function timeFromClientX(clientX: number): number {
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const frac = clamp((clientX - rect.left) / rect.width, 0, 1);
    return viewStart() + frac * viewSpan();
  }

  // Keyframe ticks visible in the current window (avoids piling sparse ticks
  // against the edges when zoomed in).
  const visibleKeyframes = createMemo(() =>
    keyframes().filter((kf) => kf >= viewStart() && kf <= viewEnd()),
  );

  function startDrag(kind: DragKind, e: PointerEvent) {
    e.preventDefault();

    const apply = (clientX: number) => {
      const t = timeFromClientX(clientX);
      if (kind === "in") {
        // Keep IN strictly before OUT, then snap to a keyframe at or before it.
        const limit = Math.max(0, outPoint() - MIN_CLIP);
        const snapped = snapIn(Math.min(t, limit), keyframes());
        setInPoint(snapped);
        seekTo(snapped);
      } else if (kind === "out") {
        const lo = inPoint() + MIN_CLIP;
        setOutPoint(clamp(t, lo, duration()));
        seekTo(outPoint());
      } else {
        seekTo(clamp(t, 0, duration()));
      }
    };

    const onMove = (ev: PointerEvent) => apply(ev.clientX);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    apply(e.clientX);
  }

  function onWheel(e: WheelEvent) {
    const d = duration();
    if (d <= 0) return;
    e.preventDefault();

    const minSpan = Math.min(MIN_VIEW_SPAN, d);
    const span = viewSpan();
    const cursorT = timeFromClientX(e.clientX);
    const factor = e.deltaY < 0 ? 1 / ZOOM_FACTOR : ZOOM_FACTOR; // up = zoom in
    const newSpan = clamp(span * factor, minSpan, d);
    if (newSpan === span) return;

    // Keep the time under the cursor pinned to the same pixel.
    const frac = span > 0 ? (cursorT - viewStart()) / span : 0;
    const newStart = clamp(cursorT - frac * newSpan, 0, d - newSpan);
    setViewStart(newStart);
    setViewEnd(newStart + newSpan);
  }

  const playheadVisible = () =>
    currentTime() >= viewStart() && currentTime() <= viewEnd();
  const zoomed = () => viewSpan() < duration() - 1e-6;

  return (
    <div class="timeline-wrap">
      <div class="timeline">
        <div
          class="tl-inner"
          ref={track}
          onPointerDown={(e) => startDrag("playhead", e)}
          onWheel={onWheel}
          style={{
            "--in": `${pct(inPoint())}%`,
            "--out": `${pct(outPoint())}%`,
            "--ph": `${pct(currentTime())}%`,
          }}
        >
          <For each={visibleKeyframes()}>
            {(kf) => (
              <div class="tl-tick" style={{ left: `${pct(kf)}%` }} />
            )}
          </For>
          <div class="tl-dim tl-dim-left" />
          <div class="tl-dim tl-dim-right" />
          <div class="tl-selection" />
          <div
            class="tl-handle tl-handle-in"
            role="slider"
            aria-label="Clip start"
            aria-valuenow={inPoint()}
            onPointerDown={(e) => {
              e.stopPropagation();
              startDrag("in", e);
            }}
          />
          <div
            class="tl-handle tl-handle-out"
            role="slider"
            aria-label="Clip end"
            aria-valuenow={outPoint()}
            onPointerDown={(e) => {
              e.stopPropagation();
              startDrag("out", e);
            }}
          />
          <Show when={playheadVisible()}>
            <div class="tl-playhead" />
          </Show>
        </div>
      </div>
      <p class="tl-info">
        <Show
          when={zoomed()}
          fallback="Scroll over the timeline to zoom in for accurate trimming"
        >
          Showing {viewSpan().toFixed(1)}s of {formatDuration(duration())}
        </Show>
      </p>
    </div>
  );
}
