import { For, Show } from "solid-js";
import {
  availableFormatIds,
  cropRect,
  encoderLabel,
  exportClip,
  exportError,
  exportedPath,
  exportProgress,
  exporting,
  fillStrategy,
  hwAccel,
  inPoint,
  losslessMode,
  outPoint,
  outputFormat,
  qualityTier,
  reframeRatio,
  resolutionId,
  setHwAccel,
  setLossless,
  setOutputFormat,
  setQualityTier,
  setResolutionId,
} from "../state";
import { isPreset, ratioLabel } from "../reframe";
import { formatInfo } from "../formats";
import { QUALITY_TIERS, RESOLUTIONS, qualityInfo } from "../quality";
import { formatDuration } from "../format";
import { revealExport } from "../ipc";

/** File name (no directory) of a saved path. */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

// Export controls. Every export re-encodes; the output format (container +
// codecs) is chosen here — MP4 by default, or MOV/MKV/WebM, making ClipSmith a
// converter too. Hardware acceleration applies to the H.264 formats only.
export default function ExportPanel() {
  const pct = () => Math.round(exportProgress() * 100);

  // Whether the chosen format uses H.264 (so the encoder toggle is relevant).
  const isH264 = () => formatInfo(outputFormat()).h264;

  // What the export will actually use: the detected encoder under Auto, or
  // libx264 when forced to software. Empty until the first detection resolves.
  const encoderText = () =>
    hwAccel() ? encoderLabel() || "Detecting…" : "Software (libx264)";

  // A short human summary of what will be reframed, or "" for an identity cut.
  const reframeSummary = () => {
    const r = reframeRatio();
    if (r === "original") return "";
    if (r === "freeform") {
      const c = cropRect();
      return c ? `Crop ${c.w}×${c.h}` : "";
    }
    if (!isPreset(r)) return "";
    const s = fillStrategy();
    const strat = s === "pad" ? "Pad" : s === "crop" ? "Crop" : "Blur";
    return `${ratioLabel(r)} · ${strat}`;
  };

  return (
    <section class="export-panel">
      <div class="field">
        <span class="field-label">
          Mode
          <span
            class="info"
            title="Re-encode gives frame-accurate cuts plus reframing, quality, and format options. Lossless stream-copies instead — instant and bit-identical — but keeps the source format and can only trim on keyframes (no reframe, quality, or resolution change)."
          >
            ?
          </span>
        </span>
        <div class="chip-group">
          <button
            type="button"
            class="chip"
            classList={{ active: !losslessMode() }}
            aria-pressed={!losslessMode()}
            title="Re-encode (frame-accurate, reframe, quality, format)"
            onClick={() => setLossless(false)}
          >
            Re-encode
          </button>
          <button
            type="button"
            class="chip"
            classList={{ active: losslessMode() }}
            aria-pressed={losslessMode()}
            title="Stream copy (instant, bit-identical, keyframe-snapped)"
            onClick={() => setLossless(true)}
          >
            Lossless
          </button>
        </div>
      </div>

      <Show when={losslessMode()}>
        <p class="reframe-hint">
          Stream copy — instant and bit-identical, keeping the source format. The
          start snaps to a keyframe; no reframe, quality, or resolution change.
        </p>
      </Show>

      <Show when={!losslessMode()}>
        <div class="field">
          <span class="field-label">
            Format
            <span
              class="info"
              title="Container and codecs for the exported file. MP4 is the most compatible; MOV/MKV also carry H.264; WebM (VP9) is open and smaller. Changing this converts the clip."
            >
              ?
            </span>
          </span>
          <div class="chip-group">
            <For each={availableFormatIds()}>
              {(id) => (
                <button
                  type="button"
                  class="chip"
                  classList={{ active: outputFormat() === id }}
                  aria-pressed={outputFormat() === id}
                  title={formatInfo(id).detail}
                  onClick={() => setOutputFormat(id)}
                >
                  {formatInfo(id).label}
                </button>
              )}
            </For>
          </div>
          <span class="export-encoder">{formatInfo(outputFormat()).detail}</span>
        </div>

        <div class="field">
        <span class="field-label">
          Quality
          <span
            class="info"
            title="How hard the encoder works. High is visually near-lossless (larger files); Balanced trades a little quality for much smaller files; Draft is fastest and smallest for quick shares. Applies to every format."
          >
            ?
          </span>
        </span>
        <div class="chip-group">
          <For each={QUALITY_TIERS}>
            {(q) => (
              <button
                type="button"
                class="chip"
                classList={{ active: qualityTier() === q.id }}
                aria-pressed={qualityTier() === q.id}
                title={q.detail}
                onClick={() => setQualityTier(q.id)}
              >
                {q.label}
              </button>
            )}
          </For>
        </div>
        <span class="export-encoder">{qualityInfo(qualityTier()).detail}</span>
      </div>

      <div class="field">
        <span class="field-label">
          Resolution
          <span
            class="info"
            title="Caps the output's shorter side (720p = 720 tall for landscape, 720 wide for portrait). Only downscales — never enlarges beyond the source — so a cap above the source size is a no-op."
          >
            ?
          </span>
        </span>
        <div class="chip-group">
          <For each={RESOLUTIONS}>
            {(res) => (
              <button
                type="button"
                class="chip"
                classList={{ active: resolutionId() === res.id }}
                aria-pressed={resolutionId() === res.id}
                onClick={() => setResolutionId(res.id)}
              >
                {res.label}
              </button>
            )}
          </For>
        </div>
        </div>
      </Show>

      <p class="export-summary">
        <span class="export-label">Clip</span>
        <span class="export-duration">
          {formatDuration(Math.max(0, outPoint() - inPoint()))}
        </span>
        <Show when={reframeSummary()}>
          {(summary) => (
            <>
              <span class="dot">&middot;</span>
              <span class="export-reframe">{summary()}</span>
            </>
          )}
        </Show>
      </p>

      <Show when={!losslessMode() && isH264()}>
        <div class="field">
          <span class="field-label">
            Encoder
            <span
              class="info"
              title="Auto uses your machine's hardware H.264 encoder (much faster) when one is available, falling back to software. Software forces libx264 (slower, most compatible). Quality is comparable either way."
            >
              ?
            </span>
          </span>
          <div class="encoder-row">
            <div class="chip-group">
              <button
                type="button"
                class="chip"
                classList={{ active: hwAccel() }}
                aria-pressed={hwAccel()}
                title="Use a hardware encoder when available"
                onClick={() => setHwAccel(true)}
              >
                Auto
              </button>
              <button
                type="button"
                class="chip"
                classList={{ active: !hwAccel() }}
                aria-pressed={!hwAccel()}
                title="Force the libx264 software encoder"
                onClick={() => setHwAccel(false)}
              >
                Software
              </button>
            </div>
            <span class="export-encoder">{encoderText()}</span>
          </div>
        </div>
      </Show>

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

      <Show when={!exporting() && exportedPath()}>
        {(path) => (
          <p class="export-done">
            <span class="export-done-check">✓</span> Saved{" "}
            <span class="export-done-name" title={path()}>
              {baseName(path())}
            </span>
            <button
              type="button"
              class="export-reveal"
              onClick={() => void revealExport(path())}
            >
              Open folder
            </button>
          </p>
        )}
      </Show>
    </section>
  );
}
