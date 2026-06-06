import { open } from "@tauri-apps/plugin-dialog";
import { ALLOWED_EXTENSIONS, loadVideo, loading } from "../state";

// Click-to-open zone. Drag-and-drop onto the same surface is added in Step 11;
// the styling already reads as a drop target.
export default function DropZone() {
  async function pick() {
    if (loading()) return;
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        { name: "Video", extensions: [...ALLOWED_EXTENSIONS] },
      ],
    });
    if (typeof selected === "string") {
      await loadVideo(selected);
    }
  }

  return (
    <button class="dropzone" onClick={pick} disabled={loading()}>
      <span class="dropzone-title">
        {loading() ? "Loading…" : "Choose a video"}
      </span>
      <span class="dropzone-hint">
        {ALLOWED_EXTENSIONS.join(", ")}
      </span>
    </button>
  );
}
