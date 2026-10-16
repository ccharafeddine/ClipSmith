// Settings + update state. Kept in its own module (not state.ts, which is the
// editor's state) since it's independent of any loaded video: the settings panel
// and its update check live for the whole session. Plain module-level Solid
// signals, per the project conventions.

import { createSignal } from "solid-js";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { checkForUpdate, type UpdateInfo } from "./ipc";

/** localStorage key for the "check for updates on startup" preference. */
const STARTUP_KEY = "clipsmith:check-updates-on-startup";

/** Read the persisted startup preference, defaulting to on. */
function loadStartupPref(): boolean {
  try {
    // Absent (first run) → on; only an explicit "false" opts out.
    return localStorage.getItem(STARTUP_KEY) !== "false";
  } catch {
    return true;
  }
}

// Whether the settings panel is open.
export const [settingsOpen, setSettingsOpen] = createSignal(false);

// The running app version, resolved once from Tauri so the version line shows
// even offline (independent of any update check).
export const [appVersion, setAppVersion] = createSignal("");

// Update-check state. `updateInfo` is null until a check resolves; `checking`
// gates concurrent checks and drives the button label; `updateError` holds a
// message from an explicit (non-silent) check that failed.
export const [updateInfo, setUpdateInfo] = createSignal<UpdateInfo | null>(null);
export const [updateChecking, setUpdateChecking] = createSignal(false);
export const [updateError, setUpdateError] = createSignal("");

// Whether to run a silent update check on launch (persisted to localStorage).
export const [checkOnStartup, setCheckOnStartupSignal] = createSignal(loadStartupPref());

/** Persist and update the "check on startup" preference. */
export function setCheckOnStartup(on: boolean): void {
  setCheckOnStartupSignal(on);
  try {
    localStorage.setItem(STARTUP_KEY, on ? "true" : "false");
  } catch {
    // localStorage may be unavailable; the in-memory signal still works.
  }
}

/** Resolve and cache the running app version for the version line. */
export async function loadAppVersion(): Promise<void> {
  if (appVersion()) return;
  try {
    setAppVersion(await getVersion());
  } catch {
    // Non-fatal: the version line just stays blank.
  }
}

/**
 * Run an update check. `silent` (startup) swallows any error so a failed check
 * never interrupts the user; an explicit click surfaces it. Concurrent calls are
 * ignored while one is in flight.
 */
export async function runUpdateCheck(silent = false): Promise<void> {
  // Updates are a desktop concern: the web demo is always the latest build.
  if (!isTauri() || updateChecking()) return;
  setUpdateChecking(true);
  setUpdateError("");
  try {
    setUpdateInfo(await checkForUpdate());
  } catch (err) {
    if (!silent) {
      setUpdateError(err instanceof Error ? err.message : String(err));
    }
  } finally {
    setUpdateChecking(false);
  }
}

/** On launch: cache the version, and (if opted in) run one silent update check. */
export function initSettings(): void {
  void loadAppVersion();
  if (isTauri() && checkOnStartup()) void runUpdateCheck(true);
}
