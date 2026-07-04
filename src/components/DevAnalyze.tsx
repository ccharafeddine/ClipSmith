import { createSignal, Show } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { analyzeSubject, cancelAnalyze } from "../ipc";
import { filePath, meta } from "../state";

// TEMPORARY dev trigger (v2 Tier 2, M1 smoke test). Runs the analyze pass on the
// loaded video and prints a summary so face detection can be validated on real
// frames before the real UI (M4). Remove once auto-reframe ships.
export default function DevAnalyze() {
  const [running, setRunning] = createSignal(false);
  const [progress, setProgress] = createSignal(0);
  const [summary, setSummary] = createSignal("");
  const [error, setError] = createSignal("");

  async function run() {
    const input = filePath();
    const m = meta();
    if (!input || !m || running()) return;
    setRunning(true);
    setSummary("");
    setError("");
    setProgress(0);
    const unlisten = await listen<number>("analyze-progress", (e) =>
      setProgress(typeof e.payload === "number" ? e.payload : 0),
    );
    try {
      const frames = await analyzeSubject(input, m.duration_secs);
      const withFace = frames.filter((f) => f.faces.length > 0).length;
      const withPerson = frames.filter((f) => f.persons.length > 0).length;
      const facePeak = frames.reduce(
        (a, f) => Math.max(a, ...f.faces.map((d) => d.score), 0),
        0,
      );
      const personPeak = frames.reduce(
        (a, f) => Math.max(a, ...f.persons.map((d) => d.score), 0),
        0,
      );
      setSummary(
        `${frames.length} frames · faces ${withFace} (peak ${Math.round(facePeak * 100)}%) · persons ${withPerson} (peak ${Math.round(personPeak * 100)}%)`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      unlisten();
      setRunning(false);
    }
  }

  return (
    <div class="field">
      <span class="field-label">Detect faces (dev)</span>
      <div class="controls">
        <button
          type="button"
          class="chip"
          disabled={running()}
          onClick={() => void run()}
        >
          {running() ? `Analyzing… ${Math.round(progress() * 100)}%` : "Analyze"}
        </button>
        <Show when={running()}>
          <button type="button" class="chip" onClick={() => void cancelAnalyze()}>
            Cancel
          </button>
        </Show>
      </div>
      <Show when={summary()}>
        <span class="export-encoder">{summary()}</span>
      </Show>
      <Show when={error()}>
        <span class="error">{error()}</span>
      </Show>
    </div>
  );
}
