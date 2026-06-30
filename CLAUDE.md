# CLAUDE.md — ClipSmith

## Project

ClipSmith is a standalone desktop app for Mac and Windows that cuts a short clip out of a full-length video file, with an optional crop. The user opens a local video, scrubs a timeline to pick start and end points, optionally crops the frame, and exports a trimmed clip to disk.

The cut is **frame-accurate**: ClipSmith re-encodes the selected range with H.264 (`libx264`), so the IN and OUT points land exactly where the user puts them — no keyframe snapping. An optional **crop** is applied in the same encode pass. Future work may add export-quality presets, hardware encoders, multiple clips/concatenation, and more.

> **History:** ClipSmith v1 was *lossless* — it stream-copied (`ffmpeg -c copy`) and snapped the IN handle to keyframes, which kept it MIT/LGPL-clean but left dead zones between keyframes that couldn't be trimmed through, and made crop impossible. It was deliberately switched to a `libx264` re-encode to get frame-accurate cuts and crop. That re-encode pulls in GPL `libx264`, which relicensed the app to **GPL-3.0**. Parts of the build plan below still describe the old lossless design; treat the sections above it as the current source of truth.

ClipSmith shares its design language and engineering conventions with its sibling app GifSmith — same minimal native aesthetic, same Tauri + SolidJS + FFmpeg stack — but it is a fully independent project and codebase. This document is self-contained; everything needed to build ClipSmith from an empty folder is described here.

### Hard constraints

- No media library, no cache, no telemetry, no ads, no accounts.
- Source video is read in place from disk, never copied or imported into the app.
- Zero intermediate files. The only file written is the final clip at the user's chosen path.
- **Export re-encodes to H.264/AAC `.mp4`** (`libx264`, CRF 18, `preset medium`). The output is always `.mp4` regardless of source container, since H.264 doesn't fit every container (e.g. `.webm`) and a crop rewrites the pixels anyway. The first video stream and all audio are kept; subtitles/attachments are dropped (they can't always be carried into mp4 — e.g. bitmap subs — and keeping them would make the export fail on those sources).
- The player doubles as the preview (looping between the handles). The export re-encodes, so the clip is near-source quality (visually near-lossless at CRF 18), not bit-identical.
- Single codebase, cross-platform via Tauri.
- **GPL-3.0 licensed** (forced by bundling `libx264`).

## Stack (locked)

| Layer | Choice | Why |
|---|---|---|
| Shell | Tauri 2.x | Native binary, ~10MB, system webview |
| Frontend | SolidJS + TypeScript + Vite | Fine-grained reactivity, ideal for 60fps timeline scrubbing |
| Styling | Plain CSS with custom properties | Light/dark via `prefers-color-scheme`, no framework overhead |
| Video probe + cut | Bundled FFmpeg (GPL, with `libx264`) as Tauri sidecar | Universal format support. Used for metadata, timeline thumbnails, and the cut itself. The cut is an `ffmpeg` re-encode subprocess — no in-process media crate. |
| Build/release | GitHub Actions + `tauri-action` | Auto-builds `.dmg` and `.msi` on tag push |

There is **no `gifski` and no encoder crate**. ClipSmith's "encoder" is a single FFmpeg `libx264` subprocess.

## Pipeline

There is no frame streaming and no in-process encoding. Cutting is one FFmpeg subprocess that decodes the selected range and re-encodes it to H.264.

### The cut

```
ffmpeg -ss {in} -i {path} -t {out - in} \
  -map 0:v:0 -map 0:a? [-vf crop=W:H:X:Y] \
  -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -movflags +faststart \
  -avoid_negative_ts make_zero -y {output}.mp4
```

- `-ss` **before** `-i` → fast input seek. When re-encoding (since ffmpeg 2.1) this is *also* frame-accurate: it seeks to the preceding keyframe, then decodes/discards up to `{in}`, so the cut starts on the exact requested frame. No keyframe snapping is needed or done.
- `-t {duration}` rather than `-to {time}` → avoids the `-ss`/`-to` offset ambiguity.
- `-map 0:v:0 -map 0:a?` → keep the first video and all audio; drop subtitles/attachments (they can't always go into mp4, e.g. bitmap subs, and keeping them would fail the export on those sources).
- `-vf crop=W:H:X:Y` → present only when a crop is set; W/H/X/Y are even source-pixel values (libx264 + yuv420p needs even dimensions).
- `-c:v libx264 -crf 18 -preset medium` → visually near-lossless re-encode.
- `{output}` is always `.mp4`.

This is implemented in `cutter.rs`, which spawns the sidecar, parses `time=` from FFmpeg stderr, and emits `export-progress` events (`0.0`-`1.0`) the frontend renders as a progress bar. `keyframes.rs` / `list_keyframes` still exist (keyframe listing) but are no longer used for snapping.

## Project structure

```
clipsmith/
├── CLAUDE.md
├── README.md
├── LICENSE                       # GPL-3.0
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
│       ├── VideoPlayer.tsx       # keeps audio — do NOT mute; hosts the crop overlay
│       ├── CropOverlay.tsx       # draggable/resizable crop rect over the stage
│       ├── Timeline.tsx          # IN/OUT handles, both free and frame-accurate
│       └── ExportPanel.tsx       # clip duration, format (MP4), crop, progress bar, Export
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
│       ├── keyframes.rs          # ffprobe packet flags → Vec<f64> (legacy; unused for snapping)
│       └── cutter.rs             # ffmpeg libx264 re-encode subprocess (+ crop, + progress)
├── scripts/
│   ├── fetch-ffmpeg.sh           # Windows: download GPL FFmpeg + ffprobe (libx264); on a Mac, delegates to build-ffmpeg-macos.sh
│   └── build-ffmpeg-macos.sh     # compiles GPL FFmpeg + static libx264 from source for the host macOS arch
└── .github/workflows/
    └── release.yml               # tauri-action, builds on tag
```

There is no `encoder.rs` and no `PreviewModal.tsx`: the encode is a single `cutter.rs` FFmpeg subprocess, and the player doubles as the preview. `CropOverlay.tsx` hosts the crop rectangle.

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

## Roadmap

ClipSmith grows toward an open-source CapCut. **Frame-accurate cutting** and **crop** are now shipped (the libx264 re-encode crossed the GPL "licensing gate" that this section once described as a future decision). Likely next steps:

1. **Export-quality presets.** Expose CRF / resolution / preset choices instead of the fixed CRF 18 / `preset medium`. Possibly a faster "draft" vs. "high quality" toggle.
2. **Hardware encoders.** Offer `h264_videotoolbox` (macOS) / `h264_nvenc`/`h264_qsv`/`h264_amf` (Windows) for much faster encodes where available, falling back to libx264.
3. **Optional lossless fast-path.** Re-add the old `-c copy` stream-copy as an opt-in for un-cropped, keyframe-aligned cuts where instant + bit-identical matters. (The copy logic is easy to restore; see git history before the re-encode switch.)
4. **Audio extraction**, mute, volume, channel selection.
5. **Multiple clips + concatenation**, then **filters**, **transitions**, and a multi-track timeline.
