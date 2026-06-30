import { createEffect, Show } from "solid-js";
import {
  currentTime,
  duration,
  filePath,
  filmstripSrc,
  inPoint,
  MIN_CLIP,
  outPoint,
  seekTo,
  setFilmstripSrc,
  setInPoint,
  setOutPoint,
  setViewEnd,
  setViewStart,
  viewEnd,
  viewStart,
} from "../state";
import { generateFilmstrip } from "../ipc";
import { formatDuration } from "../format";

// Display height of the strip, in px; one square thumbnail per this much track
// width tiles the timeline without distortion. Matches `.timeline` height.
const THUMB_PX = 72;
// Cap the thumbnail count: long videos still get a readable handful, not a row
// of unreadable slivers.
const MAX_THUMBS = 20;
const MIN_THUMBS = 6;

// Most-zoomed-in state: the window can shrink to this many seconds. Kept small
// so both handles can be placed precisely, frame by frame, for accurate trimming.
const MIN_VIEW_SPAN = 1;
// Wheel zoom step per notch.
const ZOOM_FACTOR = 1.2;

const clamp = (x: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, x));

type DragKind = "in" | "out" | "playhead";

// iOS-style trim strip with a zoomable view window. Drag the IN/OUT handles to
// frame the clip; drag elsewhere to scrub. Scroll to zoom the visible window
// (cursor-anchored, down to MIN_VIEW_SPAN). Both handles are free and
// frame-accurate — the export re-encodes, so the cut isn't tied to keyframes.
export default function Timeline() {
  let track: HTMLDivElement | undefined;

  const viewSpan = () => viewEnd() - viewStart();

  // Build the preview strip once per loaded video, sizing the thumbnail count to
  // the measured track width so the square thumbnails tile it without squishing.
  // Reactive on filePath AND duration: probe can report 0 for some containers,
  // with the real duration only arriving later from the element's metadata, so
  // we wait for a positive duration and guard against regenerating per video.
  let stripForPath = "";
  createEffect(() => {
    const path = filePath();
    const d = duration();
    if (!path || d <= 0) {
      stripForPath = "";
      return;
    }
    if (path === stripForPath) return;
    stripForPath = path;
    const w = track?.clientWidth ?? 0;
    const count = Math.min(
      MAX_THUMBS,
      Math.max(MIN_THUMBS, Math.round(w / THUMB_PX) || 12),
    );
    void generateFilmstrip(path, d, count)
      .then((uri) => {
        // Ignore a late result if another video was loaded/closed meanwhile.
        if (filePath() === path) setFilmstripSrc(uri);
      })
      .catch((e) => console.error("generate_filmstrip failed", e));
  });

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

  function startDrag(kind: DragKind, e: PointerEvent) {
    e.preventDefault();

    const apply = (clientX: number) => {
      const t = timeFromClientX(clientX);
      if (kind === "in") {
        // IN is free and frame-accurate, kept strictly before OUT.
        const limit = Math.max(0, outPoint() - MIN_CLIP);
        const next = clamp(t, 0, limit);
        setInPoint(next);
        seekTo(next);
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

  // The strip spans the whole clip; scale/shift it so the visible window fills
  // the track width as the user zooms.
  const stripWidth = () =>
    duration() > 0 ? (duration() / viewSpan()) * 100 : 100;
  const stripLeft = () =>
    duration() > 0 ? -(viewStart() / viewSpan()) * 100 : 0;

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
          <Show when={filmstripSrc()}>
            <img
              class="tl-filmstrip"
              src={filmstripSrc()}
              alt=""
              style={{ left: `${stripLeft()}%`, width: `${stripWidth()}%` }}
            />
          </Show>
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
