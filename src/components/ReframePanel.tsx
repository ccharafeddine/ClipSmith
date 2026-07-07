import { For, Match, Show, Switch } from "solid-js";
import {
  autoAnalyzing,
  autoCorrections,
  autoDetections,
  autoError,
  autoProgress,
  autoSceneCuts,
  cancelAutoAnalyze,
  chooseRatio,
  chooseStrategy,
  clearCorrections,
  fillStrategy,
  meta,
  padColor,
  reframeAnchor,
  reframeRatio,
  runAutoAnalyze,
  setPadColor,
  setReframeAnchor,
} from "../state";
import {
  anchorLabels,
  barsAxis,
  CANVAS_RATIOS,
  isPreset,
  ratioLabel,
  type FillStrategy,
} from "../reframe";

// Reframe controls (v2): pick an output canvas ratio, then how the source fills
// it. This is the single aspect control — the old standalone crop lives on as
// the "Freeform" ratio, and as the manual mode of crop-to-fill. Each setting is
// its own labelled field (label above its controls) so the groups read clearly.

const STRATEGIES: { value: FillStrategy; label: string; hint: string }[] = [
  { value: "blur", label: "Blur", hint: "Blurred, zoomed copy fills the bars" },
  { value: "pad", label: "Pad", hint: "Solid-color bars" },
  { value: "crop", label: "Crop", hint: "Scale up and crop to the canvas" },
  {
    value: "auto",
    label: "Auto-Reframe",
    hint: "Track the subject and pan the crop automatically",
  },
];

export default function ReframePanel() {
  // The letterbox-bar axis for the current preset + source, or null if the
  // aspects match (no bars → anchor is irrelevant).
  const axis = () => {
    const m = meta();
    if (!m) return null;
    return barsAxis(reframeRatio(), m.width, m.height);
  };

  const labels = () => anchorLabels(axis());

  // A compact readout of the cached analyze pass, so detection quality is visible
  // at a glance (frames sampled, shots found, peak face/person confidence).
  const detectionSummary = () => {
    const frames = autoDetections();
    if (!frames) return "";
    const shots = autoSceneCuts().length + 1;
    const facePeak = frames.reduce(
      (a, f) => Math.max(a, ...f.faces.map((d) => d.score), 0),
      0,
    );
    const personPeak = frames.reduce(
      (a, f) => Math.max(a, ...f.persons.map((d) => d.score), 0),
      0,
    );
    return `${frames.length} frames · ${shots} shots · face ${Math.round(
      facePeak * 100,
    )}% · person ${Math.round(personPeak * 100)}%`;
  };

  return (
    <section class="reframe-panel">
      <div class="field">
        <span class="field-label">
          Canvas
          <span
            class="info"
            title="Output shape. Original keeps the source ratio; 9:16/1:1/4:5/16:9 reframe to that ratio; Freeform is a free crop (exports at the box size)."
          >
            ?
          </span>
        </span>
        <div class="chip-group canvas-chips">
          <For each={CANVAS_RATIOS}>
            {(r) => (
              <button
                type="button"
                class="chip"
                classList={{ active: reframeRatio() === r }}
                aria-pressed={reframeRatio() === r}
                onClick={() => chooseRatio(r)}
              >
                {ratioLabel(r)}
              </button>
            )}
          </For>
        </div>
      </div>

      <Show when={isPreset(reframeRatio())}>
        <div class="field">
          <span class="field-label">
            Fill
            <span
              class="info"
              title="How the source fills the canvas. Blur = fit inside, blurred zoomed copy fills the bars; Pad = solid-color bars; Crop = scale up and crop to fill (drag the box)."
            >
              ?
            </span>
          </span>
          <div class="chip-group">
            <For each={STRATEGIES}>
              {(s) => (
                <button
                  type="button"
                  class="chip"
                  classList={{ active: fillStrategy() === s.value }}
                  aria-pressed={fillStrategy() === s.value}
                  title={s.hint}
                  onClick={() => chooseStrategy(s.value)}
                >
                  {s.label}
                </button>
              )}
            </For>
          </div>
        </div>

        <Show when={fillStrategy() === "pad"}>
          <div class="field">
            <span class="field-label">Bars</span>
            <input
              type="color"
              class="pad-color"
              aria-label="Bar color"
              value={padColor()}
              onInput={(e) => setPadColor(e.currentTarget.value)}
            />
          </div>
        </Show>

        <Show when={fillStrategy() === "auto"}>
          <div class="field">
            <span class="field-label">
              Subject tracking
              <span
                class="info"
                title="Auto analyzes the video for faces and people, then pans the crop to keep the subject in frame — smoothly within a shot, cutting at scene changes. Analysis runs once per video."
              >
                ?
              </span>
            </span>
            <Switch>
              <Match when={autoAnalyzing()}>
                <div class="controls">
                  <span class="export-encoder">
                    Analyzing… {Math.round(autoProgress() * 100)}%
                  </span>
                  <button
                    type="button"
                    class="chip"
                    onClick={() => cancelAutoAnalyze()}
                  >
                    Cancel
                  </button>
                </div>
              </Match>
              <Match when={autoDetections()}>
                <span class="export-encoder">
                  Tracked — the export pans to follow the subject.
                </span>
                <span class="export-encoder">{detectionSummary()}</span>
                <p class="reframe-hint">
                  Not quite right at a moment? Drag the crop box on the video to
                  fix it there — the pan eases back to auto on either side.
                </p>
                <Show when={autoCorrections().length > 0}>
                  <div class="controls">
                    <span class="export-encoder">
                      {autoCorrections().length} manual fix
                      {autoCorrections().length === 1 ? "" : "es"}
                    </span>
                    <button
                      type="button"
                      class="chip"
                      onClick={() => clearCorrections()}
                    >
                      Clear fixes
                    </button>
                  </div>
                </Show>
              </Match>
              <Match when={true}>
                <div class="controls">
                  <button
                    type="button"
                    class="chip"
                    onClick={() => void runAutoAnalyze()}
                  >
                    Analyze
                  </button>
                  <span class="export-encoder">
                    Analyze the video to follow the subject.
                  </span>
                </div>
                <Show when={autoError()}>
                  <span class="error">{autoError()}</span>
                </Show>
              </Match>
            </Switch>
          </div>
        </Show>

        <Show when={axis() && fillStrategy() !== "crop" && fillStrategy() !== "auto"}>
          <div class="field">
            <span class="field-label">
              Position
              <span
                class="info"
                title="Where the fitted frame sits within the canvas along the letterbox axis (top/center/bottom or left/center/right)."
              >
                ?
              </span>
            </span>
            <div class="chip-group">
              <button
                type="button"
                class="chip"
                classList={{ active: reframeAnchor() === "start" }}
                aria-pressed={reframeAnchor() === "start"}
                onClick={() => setReframeAnchor("start")}
              >
                {labels().start}
              </button>
              <button
                type="button"
                class="chip"
                classList={{ active: reframeAnchor() === "center" }}
                aria-pressed={reframeAnchor() === "center"}
                onClick={() => setReframeAnchor("center")}
              >
                {labels().center}
              </button>
              <button
                type="button"
                class="chip"
                classList={{ active: reframeAnchor() === "end" }}
                aria-pressed={reframeAnchor() === "end"}
                onClick={() => setReframeAnchor("end")}
              >
                {labels().end}
              </button>
            </div>
          </div>
        </Show>
      </Show>

      <Show when={reframeRatio() === "freeform"}>
        <p class="reframe-hint">
          Drag the box on the video to crop. The clip exports at the box's size.
        </p>
      </Show>

      <Show when={isPreset(reframeRatio()) && fillStrategy() === "crop"}>
        <p class="reframe-hint">
          Drag the box to choose what fills the {ratioLabel(reframeRatio())}{" "}
          canvas. It's locked to that shape and scaled up on export.
        </p>
      </Show>
    </section>
  );
}
