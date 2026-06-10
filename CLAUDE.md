# CLAUDE.md — ClipSmith

## Project

ClipSmith is a standalone desktop app for Mac and Windows that cuts a short clip out of a full-length video file — keeping the audio and every other stream intact. The user opens a local video, scrubs a timeline to pick start and end points, and exports a trimmed clip to disk.

Simple mode (v1) is **lossless**: it stream-copies the selected range with no re-encoding, so the output is bit-identical to the source and the export is near-instant. An **advanced mode** (future) will add frame-accurate cutting, format conversion, and eventually CapCut-level editing — all open source.

ClipSmith shares its design language and engineering conventions with its sibling app GifSmith — same minimal native aesthetic, same Tauri + SolidJS + LGPL-FFmpeg stack — but it is a fully independent project and codebase. This document is self-contained; everything needed to build ClipSmith from an empty folder is described here.

### Hard constraints

- No media library, no cache, no telemetry, no ads, no accounts.
- Source video is read in place from disk, never copied or imported into the app.
- **Simple mode never re-encodes.** It only stream-copies (`ffmpeg -c copy`). No video encoder is invoked, so no encoder license (e.g. GPL libx264) is ever touched. This is what keeps the app LGPL-clean.
- Zero intermediate files. The only file written is the final clip at the user's chosen path.
- **Output container matches the source container** (`.mp4`→`.mp4`, `.mkv`→`.mkv`, …). This guarantees `-c copy` always succeeds, since every source stream is by definition valid in its own container.
- No in-app preview/re-export loop. A lossless cut equals what the player already shows looping between the handles, so the player *is* the preview.
- Single codebase, cross-platform via Tauri.
- MIT licensed.

## Stack (locked)

| Layer | Choice | Why |
|---|---|---|
| Shell | Tauri 2.x | Native binary, ~10MB, system webview |
| Frontend | SolidJS + TypeScript + Vite | Fine-grained reactivity, ideal for 60fps timeline scrubbing |
| Styling | Plain CSS with custom properties | Light/dark via `prefers-color-scheme`, no framework overhead |
| Video probe + cut | Bundled FFmpeg (LGPL) as Tauri sidecar | Universal format support. Used for metadata, keyframe listing, and the cut itself. The cut is just an `ffmpeg -c copy` subprocess — no in-process media crate. |
| Build/release | GitHub Actions + `tauri-action` | Auto-builds `.dmg` and `.msi` on tag push |

There is **no `gifski` and no encoder crate**. ClipSmith's entire "encoder" is a single FFmpeg stream-copy call.

## Pipeline

There is no frame streaming and no in-process encoding. Cutting is one FFmpeg subprocess that copies packets straight through.

### 1. Keyframe discovery (on load)

After `probe_video`, fetch the video stream's keyframe timestamps. Read packet flags (no decode — fast):

```
ffprobe -v error -select_streams v:0 \
  -show_entries packet=pts_time,flags -of json {path}
```

Keep packets whose `flags` contain `K`; collect their `pts_time` into a sorted `Vec<f64>`. The first frame is always a keyframe (`0.0`).

### 2. IN-point snapping

The IN handle is **magnetic**: it snaps to the nearest keyframe at or before the requested time.

```
snap_in = max{ kf in keyframes : kf <= requested_in }   // fallback 0.0
```

This is rendered in the UI — keyframe positions show as subtle ticks on the timeline and the IN handle clicks onto them — so the snapping reads as intentional, not buggy. The OUT handle is **free** (no snapping): with `-c copy` only the start must land on a keyframe to avoid corruption; the muxer simply stops copying near the OUT point.

### 3. The cut

```
ffmpeg -ss {snap_in} -i {path} -t {out - snap_in} \
  -map 0 -c copy -avoid_negative_ts make_zero {output}
```

- `-ss` **before** `-i` → fast input seek that lands on the keyframe.
- `-t {duration}` rather than `-to {time}` → avoids the well-known `-ss`/`-to` offset ambiguity.
- `-map 0` → copy every stream (video, audio, subtitles, attachments).
- `-c copy` → no re-encode, no quality loss, no encoder license.
- `-avoid_negative_ts make_zero` → normalize timestamps so the clip starts cleanly at 0.
- `{output}` extension == source extension.

For short clips this completes in well under a second. Progress is effectively a spinner; for long copies, parse `time=` from FFmpeg stderr if a real bar is wanted later.

## Project structure

```
clipsmith/
├── CLAUDE.md
├── README.md
├── LICENSE                       # MIT
├── package.json
├── vite.config.ts
├── tsconfig.json
├── index.html
├── src/                          # SolidJS frontend
│   ├── index.tsx
│   ├── App.tsx
│   ├── state.ts                  # Solid signals: filePath, meta, keyframes, in, out
│   ├── ipc.ts                    # Tauri invoke wrappers, typed
│   ├── styles.css                # CSS variables, theme tokens
│   └── components/
│       ├── DropZone.tsx
│       ├── VideoPlayer.tsx       # keeps audio — do NOT mute
│       ├── Timeline.tsx          # IN/OUT handles + keyframe ticks; IN snaps, OUT free
│       └── ExportPanel.tsx       # minimal: clip duration, output name, format (read-only), Export
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── binaries/                 # FFmpeg sidecars, populated by scripts/fetch-ffmpeg
│   │   ├── ffmpeg-x86_64-pc-windows-msvc.exe
│   │   ├── ffmpeg-aarch64-apple-darwin
│   │   ├── ffmpeg-x86_64-apple-darwin
│   │   └── ffprobe-...           # same target triples
│   └── src/
│       ├── main.rs
│       ├── commands.rs           # probe_video, list_keyframes, export_clip
│       ├── probe.rs              # ffprobe JSON parse → VideoMeta
│       ├── keyframes.rs          # ffprobe packet flags → Vec<f64>
│       └── cutter.rs             # ffmpeg -c copy subprocess
├── scripts/
│   ├── fetch-ffmpeg.sh           # Windows: download LGPL FFmpeg + ffprobe; on a Mac, delegates to build-ffmpeg-macos.sh
│   └── build-ffmpeg-macos.sh     # compiles LGPL FFmpeg + ffprobe from source for the host macOS arch
└── .github/workflows/
    └── release.yml               # tauri-action, builds on tag
```

There is no `encoder.rs`, no `CropOverlay.tsx`, no `PreviewModal.tsx`. Simple mode has no encode settings and no separate preview step, so `ExportPanel` is small.

## Commands

```bash
# First-time setup
npm install
bash scripts/fetch-ffmpeg.sh

# Dev (hot reload frontend, recompile Rust on change)
npm run tauri dev

# Production build for current platform
npm run tauri build

# Frontend-only dev (no Tauri, useful for component work)
npm run dev

# Rust tests
cd src-tauri && cargo test

# Rust lint
cd src-tauri && cargo clippy --all-targets -- -D warnings
```

## Conventions

### TypeScript / Solid

- Use `createSignal` and `createMemo` for state. Avoid stores unless state grows past ~10 signals.
- Components are functions. Use `<Show>`, `<For>`, `<Switch>` from `solid-js` instead of ternaries and `.map()` in JSX.
- File names: `PascalCase.tsx` for components, `camelCase.ts` for everything else.
- Strict TypeScript. No `any`. Use `unknown` and narrow.
- Side effects in `createEffect`. Cleanup via `onCleanup` or the returned function.
- Never destructure props at the top of a component, it kills reactivity. Use `props.foo` inside JSX.

### Rust

- Edition 2021. `rustfmt` defaults. `clippy::pedantic` warnings on, treated as errors in CI.
- Errors with `thiserror` (library code) and `anyhow` (command handlers).
- Tauri commands return `Result<T, String>` where the string is a user-facing error message.
- No `.unwrap()` in command paths. `.expect()` only with a message explaining the invariant.
- Long-running commands accept a `tauri::AppHandle` and emit progress events (`window.emit("export-progress", ...)`) that the frontend listens for.

### CSS

- One stylesheet at `src/styles.css`. CSS custom properties for colors, spacing, radii.
- Light/dark via `@media (prefers-color-scheme: dark)` overriding the same custom properties.
- No CSS-in-JS, no Tailwind, no PostCSS plugins beyond Vite defaults.

### Aesthetic

Minimal and native. Clean lines, generous spacing, system font stack (`-apple-system, "Segoe UI", system-ui, sans-serif`). Reference [sindresorhus/Gifski](https://github.com/sindresorhus/Gifski) for visual restraint. Avoid gradients, glassmorphism, and drop shadows beyond a 1-2px ambient layer.

Token starting point (light, dark inverts the same tokens):

```css
:root {
  --bg: #ffffff;
  --bg-elev: #f5f5f7;
  --fg: #1d1d1f;
  --fg-muted: #6e6e73;
  --accent: #007aff;
  --border: #d2d2d7;
  --radius: 8px;
  --space: 8px;
}
```

## Build plan

Built from scratch in an empty folder. Each step ends with something runnable. Commit at the end of each step.

1. **Scaffold.** `npm create tauri-app@latest clipsmith`, choose Solid + TypeScript, Tauri 2.x. Set `identifier` to `com.clipsmith.app` and `productName` to `clipsmith` in `tauri.conf.json`. Verify `npm run tauri dev` opens a blank window (or `cargo build` in `src-tauri` if the GUI is blocking in this environment). Add MIT `LICENSE` (hard requirement). `git init`, first commit, push to a new GitHub repo. Commit.
2. **FFmpeg sidecars.** Write `scripts/fetch-ffmpeg.sh` that downloads LGPL builds of `ffmpeg` and `ffprobe` for `x86_64-pc-windows-msvc`, `x86_64-apple-darwin`, and `aarch64-apple-darwin`, placing them in `src-tauri/binaries/` with Tauri's required `{name}-{target-triple}` suffix. Windows: BtbN's static lgpl release (`ffmpeg-master-latest-win64-lgpl.zip`) — single self-contained `.exe`, no DLLs, verify the build config has no `--enable-gpl`. macOS: **no LGPL prebuilt exists** (evermeet.cx and friends are GPL — they bundle libx264 — which would relicense ClipSmith to GPL), so the macOS sidecars are **compiled from source** with `--disable-gpl --disable-nonfree` by `scripts/build-ffmpeg-macos.sh`. Simple mode never encodes video, so the build needs no external libs and links only macOS system frameworks (portable). `fetch_macos()` invokes that build when run on a Mac; CI builds it on macOS runners (Step 13). Configure `tauri.conf.json` `bundle.externalBin: ["binaries/ffmpeg","binaries/ffprobe"]`. Gitignore the binaries; CI must run the fetch first. Verify the dev build runs without sidecar errors on the host triple.
3. **probe_video command.** Rust command that spawns `ffprobe -v quiet -print_format json -show_streams -show_format`, parses the JSON, returns `VideoMeta { duration_secs, width, height, fps_num, fps_den, codec, container }`. Add a temporary button in the UI that calls it on a hardcoded path and logs the result.
4. **DropZone + file picker.** Replace the temp button with a real file open dialog via `@tauri-apps/plugin-dialog`. On select, store path in a signal, call `probe_video`, store meta. Show file name and duration. Extension allowlist: mp4, mov, mkv, webm, avi, m4v.
5. **VideoPlayer.** When a path is loaded, render `<video src={convertFileSrc(path)}>` with custom play/pause controls and a seekbar bound to `currentTime`. **Keep audio — do not mute the element.** No trim handles yet.
6. **list_keyframes command.** Rust command that spawns `ffprobe -v error -select_streams v:0 -show_entries packet=pts_time,flags -of json {path}`, parses the JSON, keeps packets whose `flags` contain `K`, and returns their `pts_time` as a sorted `Vec<f64>`. Call it after `probe_video` on load; store the list in a signal.
7. **Timeline with trim handles + keyframe ticks.** Build `<Timeline>` with two draggable handles (IN, OUT) layered over the seekbar. Constrain `in < out`. Render keyframe positions as subtle ticks. The IN handle magnetically snaps to the nearest keyframe at or before its position; the OUT handle is free. Loop playback between IN and OUT.
8. **export_clip command.** The core. Run the cut from the Pipeline section: `ffmpeg -ss {snap_in} -i {path} -t {out - snap_in} -map 0 -c copy -avoid_negative_ts make_zero {output}`, where `snap_in` is the snapped keyframe time. Output extension == source extension. Add an Export button that opens a save dialog defaulting the filename to `{source_stem}_clip.{ext}`, then runs the command. Verify the clip plays with audio in a normal player.
9. **Export feedback.** Show a spinner during the copy and a success state with an "Open containing folder" action. (Optional: parse `time=` from FFmpeg stderr for a real progress bar on long copies; emit `export-progress` events to the frontend.)
10. **Keyboard shortcuts.** `←`/`→` step by `1 / source_fps` seconds when the video is focused. `Space` toggles play. `I` sets IN at the playhead (snapping to the nearest keyframe). `O` sets OUT at the playhead. `Esc` cancels export / closes any dialog.
11. **Drag-and-drop.** Listen for Tauri's file drop event on the window. Accept the first dropped file if its extension is in the allowlist.
12. **Theming.** Add CSS custom properties for light and dark, override via `@media (prefers-color-scheme: dark)`. Test on both Mac and Windows.
13. **Release workflow.** `.github/workflows/release.yml` using `tauri-apps/tauri-action`. Builds on git tag push (`v*`) across a matrix (macos-14/aarch64, macos-13/x86_64, windows-latest), creates a draft GitHub Release with `.dmg` and `.msi` attached. Windows fetches the prebuilt LGPL sidecars; macOS runners compile them from source (`build-ffmpeg-macos.sh`, with `brew install nasm`) before the bundle step.
14. **README + screenshots.** Document the lossless / keyframe-snapping behavior prominently so the start-point snapping is understood as a feature, not a bug.

## Advanced mode (future roadmap)

Simple mode deliberately ships first. Advanced mode is where ClipSmith grows toward an open-source CapCut. The likely order:

1. **Frame-accurate cutting (re-encode).** Decode and re-encode the selected range for exact IN/OUT. **This is the licensing gate:** the standard H.264 encoder (libx264) is GPL and would force ClipSmith to GPL. Options to keep it permissive: hardware encoders (`h264_videotoolbox` on macOS, `h264_nvenc`/`h264_qsv`/`h264_amf` on Windows), which ship in LGPL FFmpeg but vary by hardware. Decide before building this.
2. **Smart cut.** Re-encode only the head GOP (from IN to the next keyframe), stream-copy the remainder. Frame-accurate start at near-lossless speed/quality.
3. **Format conversion / export presets.** Target container and codec choices (subject to the same encoder-license decision).
4. **Audio extraction**, mute, volume, channel selection.
5. **Multiple clips + concatenation**, then **crop**, **filters**, **transitions**, and a multi-track timeline.

Keep simple mode pristine and lossless regardless of how far advanced mode goes — it's the whole point of ClipSmith's identity.
