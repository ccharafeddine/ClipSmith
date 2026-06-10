import { onCleanup, onMount, Show } from "solid-js";
import DropZone from "./components/DropZone";
import VideoPlayer from "./components/VideoPlayer";
import ExportPanel from "./components/ExportPanel";
import Logo from "./components/Logo";
import {
  closeVideo,
  fileName,
  loadError,
  meta,
  setInAtPlayhead,
  setOutAtPlayhead,
  stepFrame,
  togglePlay,
} from "./state";
import { formatDuration } from "./format";
import "./App.css";

// Don't hijack keys while the user is typing in a field.
function isFormControl(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable
  );
}

function App() {
  // Editor keyboard shortcuts (active once a video is loaded): I/O set the trim
  // IN/OUT at the playhead, Space toggles play, arrows step one frame.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isFormControl(e.target) || !meta()) return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          stepFrame(-1);
          break;
        case "ArrowRight":
          e.preventDefault();
          stepFrame(1);
          break;
        case "i":
        case "I":
          setInAtPlayhead();
          break;
        case "o":
        case "O":
          setOutAtPlayhead();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <main class="container">
      <header class="app-header">
        <Logo />
      </header>

      <DropZone />

      <Show when={loadError()}>
        <p class="error">{loadError()}</p>
      </Show>

      <Show
        when={meta()}
        fallback={
          <div class="empty-state">Open a video to start trimming.</div>
        }
      >
        {(m) => (
          <div
            class="editor-single"
            style={{ "--aspect": `${m().width}/${m().height}` }}
          >
            <p class="meta-line">
              <span class="meta-text">
                <span class="filename">{fileName()}</span>
                {"  "}
                {formatDuration(m().duration_secs)} &middot; {m().width}&times;
                {m().height} &middot; {(m().fps_num / m().fps_den).toFixed(2)} fps
                &middot; {m().codec} &middot; {m().container}
              </span>
              <button
                type="button"
                class="close-video"
                title="Remove video"
                aria-label="Remove video"
                onClick={closeVideo}
              >
                &times;
              </button>
            </p>
            <VideoPlayer />
            <ExportPanel />
          </div>
        )}
      </Show>
    </main>
  );
}

export default App;
