import { createMemo, Show } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";
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
} from "../state";
import { formatDuration } from "../format";
import Timeline from "./Timeline";

// Renders the loaded video with custom transport controls. Audio is kept
// intact — the element is never muted, since the player doubles as the
// preview for the lossless cut. Playback loops between the IN and OUT handles.
export default function VideoPlayer() {
  const src = createMemo(() => {
    const path = filePath();
    return path ? convertFileSrc(path) : "";
  });

  function onLoadedMetadata(e: Event & { currentTarget: HTMLVideoElement }) {
    const d = e.currentTarget.duration;
    if (Number.isFinite(d)) {
      setDuration(d);
      // Clamp the seeded OUT to the element's true duration.
      if (outPoint() <= 0 || outPoint() > d) setOutPoint(d);
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
      <video
        ref={(el) => registerVideo(el)}
        class="player-video"
        src={src()}
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={onTimeUpdate}
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

        <Timeline />

        <span class="player-time">
          {formatDuration(currentTime())} / {formatDuration(duration())}
        </span>
      </div>
    </section>
  );
}
