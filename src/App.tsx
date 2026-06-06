import { createSignal, Show } from "solid-js";
import { probeVideo, type VideoMeta } from "./ipc";
import "./App.css";

// TEMPORARY (Step 3): hardcoded path used to exercise the probe_video command.
// Replaced by a real file picker in Step 4. Forward slashes work on Windows.
const TEST_PATH = "C:/Users/mnc-9/AppData/Local/Temp/cs/sample.mp4";

function App() {
  const [meta, setMeta] = createSignal<VideoMeta | null>(null);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  async function runProbe() {
    setError("");
    setMeta(null);
    setBusy(true);
    try {
      const result = await probeVideo(TEST_PATH);
      console.log("probe_video result", result);
      setMeta(result);
    } catch (e) {
      console.error("probe_video failed", e);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main class="container">
      <h1>ClipSmith</h1>
      <p>Step 3 — temporary probe test against a hardcoded path.</p>

      <button onClick={runProbe} disabled={busy()}>
        {busy() ? "Probing…" : "Probe test video"}
      </button>

      <Show when={meta()}>
        {(m) => <pre>{JSON.stringify(m(), null, 2)}</pre>}
      </Show>

      <Show when={error()}>
        <pre class="error">{error()}</pre>
      </Show>
    </main>
  );
}

export default App;
