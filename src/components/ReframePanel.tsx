import { For, Show } from "solid-js";
import {
  chooseRatio,
  chooseStrategy,
  fillStrategy,
  meta,
  padColor,
  reframeAnchor,
  reframeRatio,
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

        <Show when={axis() && fillStrategy() !== "crop"}>
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
