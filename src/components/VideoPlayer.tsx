import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { generateProxy } from "../ipc";
import {
  currentTime,
  duration,
  filePath,
  inPoint,
  outPoint,
  playing,
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
import { formatDuration } from "../format";
import Timeline from "./Timeline";

// Renders the loaded video with custom transport controls. Audio is kept
// intact — the element is never muted, since the player doubles as the
// preview for the lossless cut. Playback loops between the IN and OUT handles.
export default function VideoPlayer() {
  // When the webview can't decode the file's codec (common with .avi MPEG-4,
  // HEVC, ProRes), ffmpeg transcodes a lightweight H.264 proxy that playback
  // uses instead. Export always cuts the original, so the clip stays lossless.
  const [proxySrc, setProxySrc] = createSignal<string | null>(null);
  const [proxyBuilding, setProxyBuilding] = createSignal(false);
  const [proxyFailed, setProxyFailed] = createSignal(false);

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
    // Loop within the trim range while playing.
    if (playing() && outPoint() > inPoint() && t >= outPoint()) {
      seekTo(inPoint());
    }
  }

  return (
    <section class="player">
      <div class="stage">
        <video
          ref={(el) => registerVideo(el)}
          src={src()}
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={onTimeUpdate}
          onError={buildProxy}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
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
