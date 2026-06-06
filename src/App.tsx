import { Show } from "solid-js";
import DropZone from "./components/DropZone";
import { fileName, loadError, meta } from "./state";
import { formatDuration } from "./format";
import "./App.css";

function App() {
  return (
    <main class="container">
      <h1>ClipSmith</h1>

      <DropZone />

      <Show when={loadError()}>
        <p class="error">{loadError()}</p>
      </Show>

      <Show when={meta()}>
        {(m) => (
          <section class="meta">
            <p class="meta-name">{fileName()}</p>
            <p class="meta-line">
              {formatDuration(m().duration_secs)} · {m().width}×{m().height} ·{" "}
              {m().codec} · {m().container}
            </p>
          </section>
        )}
      </Show>
    </main>
  );
}

export default App;
