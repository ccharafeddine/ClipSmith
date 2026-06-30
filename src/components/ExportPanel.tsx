import { Show } from "solid-js";
import {
  clearCrop,
  cropRect,
  exportClip,
  exportError,
  exportProgress,
  exporting,
  inPoint,
  outPoint,
} from "../state";
import { formatDuration } from "../format";

// Export controls. Every export re-encodes to a frame-accurate H.264/AAC mp4
// (libx264), optionally cropped, so the format is always MP4 and a progress bar
// reflects the encode. A crop, if set, is summarized with a clear (×) action.
export default function ExportPanel() {
  const pct = () => Math.round(exportProgress() * 100);

  return (
    <section class="export-panel">
      <div class="export-meta">
        <span class="export-label">Clip</span>
        <span class="export-duration">
          {formatDuration(Math.max(0, outPoint() - inPoint()))}
        </span>
        <span class="export-label">Format</span>
        <span class="export-format">MP4</span>
        <Show when={cropRect()}>
          {(c) => (
            <>
              <span class="export-label">Crop</span>
              <span class="export-crop">
                {c().w}×{c().h}
                <button
                  type="button"
                  class="crop-clear"
                  title="Remove crop"
                  aria-label="Remove crop"
                  onClick={clearCrop}
                >
                  ×
                </button>
              </span>
            </>
          )}
        </Show>
      </div>

      <button
        class="export export-button"
        type="button"
        onClick={() => void exportClip()}
        disabled={exporting()}
      >
        {exporting() ? `Exporting… ${pct()}%` : "Export clip"}
      </button>

      <Show when={exporting()}>
        <div class="export-progress">
          <div class="export-progress-fill" style={{ width: `${pct()}%` }} />
        </div>
      </Show>

      <Show when={exportError()}>
        <p class="error export-error">{exportError()}</p>
      </Show>
    </section>
  );
}
