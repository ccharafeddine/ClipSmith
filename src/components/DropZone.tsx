import { createSignal, Show } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { ALLOWED_EXTENSIONS, loadVideo, loading } from "../state";
import { downloadVideo, cancelDownload } from "../ipc";

// Click-to-open zone plus a URL field that imports remote videos (YouTube and
// other sites via the bundled yt-dlp, or a direct link to a video file). The
// download lands in an OS temp file that's then loaded as an ordinary source.
export default function DropZone() {
  const [url, setUrl] = createSignal("");
  const [downloading, setDownloading] = createSignal(false);
  const [dlProgress, setDlProgress] = createSignal(0);
  const [urlError, setUrlError] = createSignal("");
  // Set just before requesting cancellation so the resulting error is swallowed.
  let userCancelledDownload = false;

  async function pick() {
    if (loading() || downloading()) return;
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Video", extensions: [...ALLOWED_EXTENSIONS] }],
    });
    if (typeof selected === "string") {
      await loadVideo(selected);
    }
  }

  async function loadFromUrl(e: Event) {
    e.preventDefault();
    const link = url().trim();
    if (!link || downloading() || loading()) return;

    setUrlError("");
    setDlProgress(0);
    setDownloading(true);
    userCancelledDownload = false;
    const unlisten = await listen<number>("download-progress", (ev) =>
      setDlProgress(ev.payload),
    );
    try {
      const path = await downloadVideo(link);
      await loadVideo(path);
      setUrl("");
    } catch (err) {
      // A user-requested cancel surfaces as the cancelled error; ignore it.
      if (!userCancelledDownload) setUrlError(String(err));
    } finally {
      unlisten();
      setDownloading(false);
      userCancelledDownload = false;
    }
  }

  async function abortDownload() {
    userCancelledDownload = true;
    try {
      await cancelDownload();
    } catch {
      // loadFromUrl's finally block clears the downloading state.
    }
  }

  const busy = () => loading() || downloading();

  return (
    <div class="loader">
      <button class="dropzone" onClick={pick} disabled={busy()}>
        <span class="dropzone-title">
          {loading() ? "Loading…" : "Choose a video"}
        </span>
        <span class="dropzone-hint">{ALLOWED_EXTENSIONS.join(", ")}</span>
      </button>

      <form class="url-row" onSubmit={loadFromUrl}>
        <input
          type="text"
          class="url-input"
          placeholder="or paste a video URL (YouTube, etc.)"
          value={url()}
          onInput={(e) => setUrl(e.currentTarget.value)}
          disabled={busy()}
        />
        <button type="submit" disabled={busy() || !url().trim()}>
          {downloading() ? "Downloading…" : "Load"}
        </button>
      </form>

      <Show when={downloading()}>
        <div class="dl-progress-row">
          <div class="dl-progress">
            <div
              class="dl-progress-fill"
              style={{ width: `${Math.round(dlProgress() * 100)}%` }}
            />
          </div>
          <span class="dl-progress-pct">
            {Math.round(dlProgress() * 100)}%
          </span>
          <button type="button" class="dl-cancel" onClick={abortDownload}>
            Cancel
          </button>
        </div>
      </Show>

      <Show when={urlError()}>
        <p class="error">{urlError()}</p>
      </Show>
    </div>
  );
}
