import { createEffect, createMemo, createSignal, Show, type JSX } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { generateProxy } from "../ipc";
import {
  currentTime,
  duration,
  fillStrategy,
  filePath,
  inPoint,
  meta,
  outPoint,
  padColor,
  playing,
  reframeAnchor,
  reframeRatio,
  registerVideo,
  seekTo,
  setCurrentTime,
  setDuration,
  setOutPoint,
  setPlaying,
  togglePlay,
  viewEnd,
  setViewEnd,
} from "../state";
import { anchorObjectPosition, barsAxis, isPreset } from "../reframe";
import { formatDuration } from "../format";
import Timeline from "./Timeline";
import CropOverlay from "./CropOverlay";

// Renders the loaded video with custom transport controls. Audio is kept
// intact — the element is never muted, since the player doubles as the preview.
// Playback loops between the IN and OUT handles.
//
// The stage doubles as the live reframe preview: it takes the output canvas
// aspect (set via --aspect on the editor container), the foreground video is
// `contain`-fitted and anchored, and — for blur-fill — a second muted, blurred
// copy of the video fills the bars behind it. Pad shows a solid-color backdrop.
// None of this touches the export; it's a CSS-only mirror of the filtergraph.
export default function VideoPlayer() {
  // When the webview can't decode the file's codec (common with .avi MPEG-4,
  // HEVC, ProRes), ffmpeg transcodes a lightweight H.264 proxy that playback
  // uses instead. Export always cuts the original.
  const [proxySrc, setProxySrc] = createSignal<string | null>(null);
  const [proxyBuilding, setProxyBuilding] = createSignal(false);
  const [proxyFailed, setProxyFailed] = createSignal(false);

  // The blurred-bar background video for blur-fill preview. Muted and synced to
  // the main element; decorative, so small drift is invisible under the blur.
  let bgEl: HTMLVideoElement | undefined;

  const src = createMemo(() => {
    const proxy = proxySrc();
    if (proxy) return proxy;
    const path = filePath();
    return path ? convertFileSrc(path) : "";
  });

  // New source: drop any proxy from the previous video so the original is tried
  // first. filePath() is the trigger; the proxy is rebuilt on error if needed.
  createEffect(() => {
    filePath();
    setProxySrc(null);
    setProxyBuilding(false);
    setProxyFailed(false);
  });

  function buildProxy() {
    // Already showing a proxy and it still errors: give up.
    if (proxySrc()) {
      setProxyFailed(true);
      return;
    }
    if (proxyBuilding()) return;
    const p = filePath();
    if (!p) return;
    setProxyBuilding(true);
    setProxyFailed(false);
    generateProxy(p)
      .then((proxyPath) => setProxySrc(convertFileSrc(proxyPath)))
      .catch(() => setProxyFailed(true))
      .finally(() => setProxyBuilding(false));
  }

  const selectionLength = () => Math.max(0, outPoint() - inPoint());

  // Whether the blurred background layer should show (blur-fill on a preset).
  const showBlurBg = () =>
    isPreset(reframeRatio()) && fillStrategy() === "blur";

  // Foreground fit: presets `contain`-fit and anchor the source; original and
  // freeform fill the (source-shaped) stage exactly as v1 did.
  const fgStyle = (): JSX.CSSProperties => {
    const m = meta();
    const r = reframeRatio();
    // Blur/pad fit into the canvas shape; original, freeform, and manual
    // crop-to-fill show the full source frame (crop-to-fill edits via the box).
    if (!m || !isPreset(r) || fillStrategy() === "crop") return {};
    const axis = barsAxis(r, m.width, m.height);
    return {
      "object-fit": "contain",
      "object-position": anchorObjectPosition(reframeAnchor(), axis),
    };
  };

  // Pad shows a solid-color backdrop; every other case stays on the black stage.
  const stageStyle = (): JSX.CSSProperties => {
    if (isPreset(reframeRatio()) && fillStrategy() === "pad") {
      return { background: padColor() };
    }
    return {};
  };

  function onLoadedMetadata(e: Event & { currentTarget: HTMLVideoElement }) {
    // Some codecs "load" but decode to nothing (videoWidth 0): proxy it.
    if (e.currentTarget.videoWidth === 0) {
      buildProxy();
      return;
    }
    const d = e.currentTarget.duration;
    if (Number.isFinite(d)) {
      setDuration(d);
      // Clamp the seeded OUT to the element's true duration.
      if (outPoint() <= 0 || outPoint() > d) setOutPoint(d);
      // Keep the zoom window valid: extend it to the true duration only while
      // still fully zoomed out, so an explicit zoom isn't clobbered.
      if (viewEnd() <= 0 || viewEnd() > d) setViewEnd(d);
    }
    setCurrentTime(0);
    setPlaying(false);
  }

  function onTimeUpdate(e: Event & { currentTarget: HTMLVideoElement }) {
    const t = e.currentTarget.currentTime;
    setCurrentTime(t);
    // Keep the blurred background frame-aligned with the main video.
    if (showBlurBg() && bgEl && Math.abs(bgEl.currentTime - t) > 0.2) {
      try {
        bgEl.currentTime = t;
      } catch {
        // Seeking before the bg element is ready throws; ignore, it'll catch up.
      }
    }
    // Loop within the trim range while playing.
    if (playing() && outPoint() > inPoint() && t >= outPoint()) {
      seekTo(inPoint());
    }
  }

  return (
    <section class="player">
      <div class="stage-wrap">
        <div class="stage" style={stageStyle()}>
        <Show when={showBlurBg()}>
          <video
            class="stage-bg"
            src={src()}
            muted
            // Mirror the main element's transport on mount so a mid-playback
            // switch to blur-fill doesn't leave the backdrop frozen.
            ref={(el) => {
              bgEl = el;
              try {
                el.currentTime = currentTime();
              } catch {
                /* not ready yet */
              }
              if (playing()) void el.play().catch(() => {});
            }}
          />
        </Show>
        <video
          class="stage-fg"
          ref={(el) => registerVideo(el)}
          src={src()}
          style={fgStyle()}
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={onTimeUpdate}
          onError={buildProxy}
          onPlay={() => {
            setPlaying(true);
            if (bgEl) void bgEl.play().catch(() => {});
          }}
          onPause={() => {
            setPlaying(false);
            bgEl?.pause();
          }}
          onEnded={() => setPlaying(false)}
        />
        <Show when={proxyBuilding()}>
          <div class="stage-msg">
            <p>Preparing preview…</p>
            <p class="stage-msg-sub">
              Transcoding a lightweight copy so this codec plays here. Export
              uses the original.
            </p>
          </div>
        </Show>
        <Show when={proxyFailed()}>
          <div class="stage-msg">
            <p>Can't preview this codec in the window.</p>
            <p class="stage-msg-sub">
              Trimming and export still work — the timeline thumbnails and the
              clip are built with FFmpeg.
            </p>
          </div>
        </Show>
        <CropOverlay />
        </div>
      </div>

      <Timeline />

      <div class="controls">
        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing() ? "Pause" : "Play"}
        >
          <Show when={playing()} fallback="Play">
            Pause
          </Show>
        </button>
        <span class="time">
          {formatDuration(currentTime())} / {formatDuration(duration())}
        </span>
        <span class="selection-len">
          Selection {selectionLength().toFixed(2)}s
        </span>
      </div>
    </section>
  );
}
