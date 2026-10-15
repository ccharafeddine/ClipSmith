import { onCleanup, onMount, Show } from "solid-js";
import DropZone from "./components/DropZone";
import VideoPlayer from "./components/VideoPlayer";
import ReframePanel from "./components/ReframePanel";
import ExportPanel from "./components/ExportPanel";
import Wordmark from "./smith/Wordmark";
import SettingsPanel from "./components/SettingsPanel";
import { initSettings, settingsOpen, setSettingsOpen } from "./settings";
import {
  closeVideo,
  fileName,
  loadError,
  losslessMode,
  meta,
  setInAtPlayhead,
  setOutAtPlayhead,
  stageAspect,
  stepFrame,
  togglePlay,
} from "./state";
import { formatDuration } from "./format";
import "./App.css";
import "./smith/shell.css";

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
  // Resolve the app version and, if opted in, run a silent update check on launch.
  onMount(initSettings);

  // Editor keyboard shortcuts (active once a video is loaded): I/O set the trim
  // IN/OUT at the playhead, Space toggles play, arrows step one frame.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc closes the settings panel (works with or without a loaded video).
      if (e.key === "Escape" && settingsOpen()) {
        setSettingsOpen(false);
        return;
      }
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
      <header class="app-header sm-topbar">
        <Wordmark />
        <span class="smith-vsep" />
        <nav class="smith-steps" aria-label="Steps">
          <span classList={{ on: !meta() }}>1. Open</span>
          <span aria-hidden="true">›</span>
          <span classList={{ on: !!meta() }}>2. Trim &amp; reframe</span>
          <span aria-hidden="true">›</span>
          <span>3. Export</span>
        </nav>
        <span class="smith-grow" />
        <span class="sm-chip" title="Opening, trimming and exporting local files never needs the internet">
          <i class="smith-dot" /> Works offline
        </span>
        <button
          type="button"
          class="settings-gear"
          title="Settings"
          aria-label="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path
              fill="currentColor"
              fill-rule="evenodd"
              clip-rule="evenodd"
              d="M19.14 12.94c.04-.31.06-.62.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.57.24-1.12.56-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.74 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.62-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .61.22l2.39-.96c.5.38 1.05.7 1.62.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.57-.24 1.12-.56 1.62-.94l2.39.96a.5.5 0 0 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z"
            />
          </svg>
        </button>
      </header>

      <Show when={settingsOpen()}>
        <SettingsPanel />
      </Show>

      <Show when={loadError()}>
        <p class="error">{loadError()}</p>
      </Show>

      <Show
        when={meta()}
        fallback={
          <div class="empty-state">
            <DropZone />
          </div>
        }
      >
        {(m) => (
          <div class="editor" style={{ "--aspect": `${stageAspect()}` }}>
            <VideoPlayer />
            <aside class="editor-side">
              <div class="meta-line">
                <span class="filename" title={fileName()}>
                  {fileName()}
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
              </div>
              <p class="meta-detail">
                {formatDuration(m().duration_secs)} &middot; {m().width}&times;
                {m().height} &middot; {(m().fps_num / m().fps_den).toFixed(2)} fps
                &middot; {m().codec} &middot; {m().container}
              </p>
              <Show when={!losslessMode()}>
                <ReframePanel />
              </Show>
              <ExportPanel />
            </aside>
          </div>
        )}
      </Show>
    </main>
  );
}

export default App;
