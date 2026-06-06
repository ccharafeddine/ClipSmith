import { createMemo, createSignal, Show } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { filePath, meta } from "../state";
import { formatDuration } from "../format";

// Renders the loaded video with custom transport controls. Audio is kept
// intact — the element is never muted, since the player doubles as the
// preview for the lossless cut. Trim handles arrive in Step 7.
export default function VideoPlayer() {
  let videoEl: HTMLVideoElement | undefined;

  const [playing, setPlaying] = createSignal(false);
  const [currentTime, setCurrentTime] = createSignal(0);
  // Seed duration from probe metadata; refine once the element reports its own.
  const [duration, setDuration] = createSignal(meta()?.duration_secs ?? 0);

  const src = createMemo(() => {
    const path = filePath();
    return path ? convertFileSrc(path) : "";
  });

  function togglePlay() {
    if (!videoEl) return;
    if (videoEl.paused) {
      void videoEl.play();
    } else {
      videoEl.pause();
    }
  }

  function onLoadedMetadata() {
    if (!videoEl) return;
    // A new source resets transport state.
    setDuration(Number.isFinite(videoEl.duration) ? videoEl.duration : 0);
    setCurrentTime(0);
    setPlaying(false);
  }

  function onSeek(value: number) {
    if (videoEl) videoEl.currentTime = value;
    setCurrentTime(value);
  }

  return (
    <section class="player">
      <video
        ref={videoEl}
        class="player-video"
        src={src()}
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={() => setCurrentTime(videoEl?.currentTime ?? 0)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />

      <div class="player-controls">
        <button
          class="player-play"
          onClick={togglePlay}
          aria-label={playing() ? "Pause" : "Play"}
        >
          <Show when={playing()} fallback="▶">
            ❚❚
          </Show>
        </button>

        <input
          class="player-seek"
          type="range"
          min={0}
          max={duration() || 0}
          step="any"
          value={currentTime()}
          onInput={(e) => onSeek(e.currentTarget.valueAsNumber)}
        />

        <span class="player-time">
          {formatDuration(currentTime())} / {formatDuration(duration())}
        </span>
      </div>
    </section>
  );
}
