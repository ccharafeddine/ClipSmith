import { Show } from "solid-js";
import DropZone from "./components/DropZone";
import VideoPlayer from "./components/VideoPlayer";
import ExportPanel from "./components/ExportPanel";
import Logo from "./components/Logo";
import { fileName, loadError, meta } from "./state";
import { formatDuration } from "./format";
import "./App.css";

function App() {
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
