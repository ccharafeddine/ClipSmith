import { Show } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { isTauri } from "@tauri-apps/api/core";
import { ALLOWED_EXTENSIONS, loadVideo, loading } from "../state";
import LinkImport from "./LinkImport";
import "../fetch.css";

// Click-to-open zone plus (desktop only) link import via the shared smith-fetch
// engine: yt-dlp, direct files, page scraping and an in-app browser sniffer.
// The download lands in a temp file that's then loaded as an ordinary source.
export default function DropZone() {
  async function pick() {
    if (loading()) return;
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Video", extensions: [...ALLOWED_EXTENSIONS] }],
    });
    if (typeof selected === "string") {
      await loadVideo(selected);
    }
  }

  const busy = () => loading();

  const acceptedHint = `Accepted: ${ALLOWED_EXTENSIONS.join(", ").toUpperCase()}`;

  return (
    <div class="loader sm-panel smith-drop">
      <div class="sm-empty__art" aria-hidden="true">[ ]</div>
      <h3 class="smith-drop-title">Open a video to start</h3>
      <p class="smith-drop-sub">Trim, reframe and export clips. Local files never leave this computer.</p>
      <button
        class="sm-btn sm-btn--primary sm-btn--lg upload-btn"
        onClick={pick}
        disabled={busy()}
        title={acceptedHint}
      >
        {loading() ? "Loading…" : "Open video…"}
      </button>
      <p class="smith-drop-formats">{ALLOWED_EXTENSIONS.map((e) => e.toUpperCase()).join(" · ")}</p>

      {/* Link downloads are desktop-only; the web demo only opens local files. */}
      <Show when={isTauri()}>
        <div class="smith-or"><span>or paste a link · optional, needs internet</span></div>
        <LinkImport disabled={loading()} onFile={(path) => loadVideo(path)} />
      </Show>
    </div>
  );
}
