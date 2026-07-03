import { Show } from "solid-js";
import {
  appVersion,
  checkOnStartup,
  runUpdateCheck,
  setCheckOnStartup,
  setSettingsOpen,
  updateChecking,
  updateError,
  updateInfo,
} from "../settings";
import { openExternal } from "../ipc";

// Settings panel: a modal over the editor. Shows the app version and an in-app
// update check against GitHub Releases (prompt-only — the Download button opens
// the release page; ClipSmith never installs an update itself), plus a
// persisted "check on startup" toggle.
export default function SettingsPanel() {
  const info = updateInfo;

  // The one-line update status under the button, reflecting the current check.
  const statusText = () => {
    if (updateChecking()) return "Checking…";
    if (updateError()) return updateError();
    const i = info();
    if (!i) return "";
    return i.isNewer
      ? `Update available: v${i.latest}`
      : `You're on the latest version.`;
  };

  return (
    <div
      class="settings-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onClick={() => setSettingsOpen(false)}
    >
      {/* Stop clicks inside the card from closing the panel. */}
      <div class="settings-card" onClick={(e) => e.stopPropagation()}>
        <div class="settings-head">
          <h2 class="settings-title">Settings</h2>
          <button
            type="button"
            class="close-video"
            title="Close"
            aria-label="Close settings"
            onClick={() => setSettingsOpen(false)}
          >
            &times;
          </button>
        </div>

        <div class="field">
          <span class="field-label">Version</span>
          <span class="settings-version">
            ClipSmith {appVersion() ? `v${appVersion()}` : ""}
          </span>
        </div>

        <div class="field">
          <span class="field-label">Updates</span>
          <div class="settings-update-row">
            <button
              type="button"
              class="chip"
              onClick={() => void runUpdateCheck(false)}
              disabled={updateChecking()}
            >
              {updateChecking() ? "Checking…" : "Check for updates"}
            </button>
            <Show when={statusText()}>
              <span
                class="settings-update-status"
                classList={{
                  "is-error": Boolean(updateError()),
                  "is-available": Boolean(info()?.isNewer),
                }}
              >
                {statusText()}
              </span>
            </Show>
          </div>

          <Show when={info()?.isNewer}>
            <div class="settings-update-detail">
              <Show when={info()?.notes}>
                <pre class="settings-notes">{info()?.notes}</pre>
              </Show>
              <button
                type="button"
                class="export"
                onClick={() => void openExternal(info()?.url ?? "")}
              >
                Download v{info()?.latest}
              </button>
            </div>
          </Show>
        </div>

        <div class="field">
          <label class="settings-toggle">
            <input
              type="checkbox"
              checked={checkOnStartup()}
              onChange={(e) => setCheckOnStartup(e.currentTarget.checked)}
            />
            <span>Check for updates on startup</span>
          </label>
        </div>
      </div>
    </div>
  );
}
