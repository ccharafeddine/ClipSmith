import { Show } from "solid-js";
import {
  exportClip,
  exportError,
  exporting,
  inPoint,
  meta,
  outPoint,
} from "../state";
import { formatDuration } from "../format";

// Minimal export controls for simple mode: the clip duration, the output
// format as read-only text, and an Export button. Simple mode never
// transcodes, so the format is fixed to the source container and shown only to
// confirm what the lossless cut will write.
export default function ExportPanel() {
  return (
    <section class="export">
      <div class="export-meta">
        <span class="export-duration">
          {formatDuration(Math.max(0, outPoint() - inPoint()))}
        </span>
        <Show when={meta()}>
          {(m) => <span class="export-format">{m().container}</span>}
        </Show>
      </div>

      <button
        class="export-button"
        onClick={() => void exportClip()}
        disabled={exporting()}
      >
        {exporting() ? "Exporting…" : "Export"}
      </button>

      <Show when={exportError()}>
        <p class="error">{exportError()}</p>
      </Show>
    </section>
  );
}
