# CLAUDE.md — ClipSmith

## Project

ClipSmith is a standalone desktop app for Mac and Windows that cuts a short clip out of a full-length video file, with an optional crop. The user opens a local video, scrubs a timeline to pick start and end points, optionally crops the frame, and exports a trimmed clip to disk.

The cut is **frame-accurate**: ClipSmith re-encodes the selected range with H.264 (`libx264`), so the IN and OUT points land exactly where the user puts them — no keyframe snapping. An optional **crop** is applied in the same encode pass. Future work may add export-quality presets, hardware encoders, multiple clips/concatenation, and more.

> **History:** ClipSmith v1 was *lossless* — it stream-copied (`ffmpeg -c copy`) and snapped the IN handle to keyframes, which kept it MIT/LGPL-clean but left dead zones between keyframes that couldn't be trimmed through, and made crop impossible. It was deliberately switched to a `libx264` re-encode to get frame-accurate cuts and crop. That re-encode pulls in GPL `libx264`, which relicensed the app to **GPL-3.0**. Parts of the build plan below still describe the old lossless design; treat the sections above it as the current source of truth.

ClipSmith shares its design language and engineering conventions with its sibling app GifSmith — same minimal native aesthetic, same Tauri + SolidJS + FFmpeg stack — but it is a fully independent project and codebase. This document is self-contained; everything needed to build ClipSmith from an empty folder is described here.

> **v2 is in progress — see [## v2: Reframe](#v2-reframe) below.** The "optional crop" described in this Project section is being generalized into **Reframe**: the target ratio becomes an output *canvas*, and the user chooses how the source fills it (blur-fill / pad / crop-to-fill). The old crop lives on as the manual mode of crop-to-fill and as the "Freeform" canvas. Where this section and the v2 section disagree, **the v2 section wins** for the parts marked shipped there.

### Hard constraints

- No media library, no cache, no telemetry, no ads, no accounts.
- Source video is read in place from disk, never copied or imported into the app.
- Zero intermediate files. The only file written is the final clip at the user's chosen path.
- **Export re-encodes; MP4 (H.264/AAC) is the default.** v2 adds an output **format** picker (see [## v2: Reframe](#v2-reframe) → *Output formats*): MP4/MOV/MKV (H.264/AAC) and WebM (VP9/Opus), so ClipSmith doubles as a container/codec converter. The first video stream and all audio are kept; subtitles/attachments are dropped (they can't always be carried into these containers — e.g. bitmap subs — and keeping them would make the export fail on those sources). *(v1 always wrote `.mp4`; that constraint is intentionally relaxed by the v2 format picker.)*
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

There is no `PreviewModal.tsx`: the player doubles as the preview. `CropOverlay.tsx` hosts the crop rectangle. (v2 adds `encoders.rs` — hardware-encoder detection — but the encode is still a single `cutter.rs` FFmpeg subprocess; `encoders.rs` only chooses its `-c:v` flags. See [## v2: Reframe](#v2-reframe).)

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

# Frontend type-check + unit tests (vitest, pure-logic modules)
npm run typecheck
npm test

# Rust tests + lint + format
cd src-tauri && cargo test
cd src-tauri && cargo clippy --all-targets -- -D warnings
cd src-tauri && cargo fmt --all -- --check
```

CI (`.github/workflows/ci.yml`) runs all of these on every push/PR to `master`
(frontend job: typecheck + vitest + build; Rust job on Ubuntu with the Tauri
system deps: `cargo fmt --check` + clippy + tests). Installer builds are separate
(`release.yml`, on a `v*` tag).

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
13. **Release workflow.** `.github/workflows/release.yml` using `tauri-apps/tauri-action`. Builds on git tag push (`v*`): a **universal** macOS `.dmg` on the `macos-14` (Apple Silicon) runner — arm64 native + x86_64 cross, `--target universal-apple-darwin` — plus a Windows `.msi` on `windows-latest`. The deprecated `macos-13` Intel runner is avoided (it sits queued indefinitely). Windows fetches the prebuilt GPL FFmpeg sidecars; macOS compiles both arches from source and `lipo`s them (`build-ffmpeg-macos.sh`, with `brew install nasm`). All runners also fetch the `yt-dlp` sidecar before bundling. Creates a draft GitHub Release with the `.dmg` and `.msi` attached.
14. **README + screenshots.** Document the lossless / keyframe-snapping behavior prominently so the start-point snapping is understood as a feature, not a bug.

## Roadmap

ClipSmith grows toward an open-source CapCut. **Frame-accurate cutting** and **crop** are now shipped (the libx264 re-encode crossed the GPL "licensing gate" that this section once described as a future decision). Likely next steps:

1. **Export-quality presets.** Expose CRF / resolution / preset choices instead of the fixed CRF 18 / `preset medium`. Possibly a faster "draft" vs. "high quality" toggle.
2. **Hardware encoders.** Offer `h264_videotoolbox` (macOS) / `h264_nvenc`/`h264_qsv`/`h264_amf` (Windows) for much faster encodes where available, falling back to libx264.
3. **Optional lossless fast-path.** Re-add the old `-c copy` stream-copy as an opt-in for un-cropped, keyframe-aligned cuts where instant + bit-identical matters. (The copy logic is easy to restore; see git history before the re-encode switch.)
4. **Audio extraction**, mute, volume, channel selection.
5. **Multiple clips + concatenation**, then **filters**, **transitions**, and a multi-track timeline.

## v2: Reframe

**Reframe** generalizes v1's destructive crop. The target ratio becomes an output **canvas**, and the user picks how the source fills it. This is now the *primary aspect control* — there is deliberately **one** ratio picker, not a crop feature competing with an aspect feature. Everything still runs through the same single `cutter.rs` libx264 re-encode pass; reframe only builds a smarter filtergraph. All v1 constraints hold (local-first, no telemetry/accounts, source read in place, zero persistent intermediate files, GPL-3.0).

### The model

- **Canvas** — an output ratio: `9:16`, `1:1`, `4:5`, `16:9`, plus `original` (source ratio) and `freeform`. Canvas pixel dimensions are computed **on the frontend** (`src/reframe.ts` `canvasDims`) as the single source of truth, so the live preview and the export always agree, and passed to the backend as even integers. Rule: lock to source height, fall back to width-locked if that would overflow — the canvas never upscales beyond the source's bounding box.
- **Fill strategy** — how the source fills the canvas:
  - **Blur-fill** — fit the whole frame inside the canvas; fill the leftover bars with a blurred, zoomed copy of the same video. Nothing is lost. FFmpeg: `split` → bg branch `scale …:force_original_aspect_ratio=increase, crop, gblur` → fg branch `scale …:force_original_aspect_ratio=decrease` → `overlay`. Complex graph → `-filter_complex`, output mapped `[v]`.
  - **Pad** — same fit, but solid-color bars (user color, default black): `scale …:decrease, pad=W:H:x:y:color`. Simple `-vf`.
  - **Crop-to-fill** — scale up and crop to the canvas (loses edges). Two sub-modes: **manual** (repurposed crop rectangle, AR-locked to the canvas) and **auto/subject-aware** (Tier 2). `crop, scale`.
- **Position (anchor)** — where the fitted source / kept region sits along the bar axis: top/center/bottom for a portrait canvas, left/center/right for a landscape one. Applied as an ffmpeg offset expression so it's a no-op on the axis without bars.
- **Freeform** is the free-crop escape hatch (design decision, confirmed with the user): an *unconstrained* crop whose output dimensions are the rectangle itself. Because the canvas equals the crop's own size, `cutter.rs` emits the bare `crop=w:h:x:y` — **byte-identical to v1's crop**, so v1 behavior is preserved, not merely approximated.
- **Identity:** `original` with no crop sends `reframe = null`, which takes the exact v1 no-filter frame-accurate path.

### Filtergraphs (`cutter.rs`)

`export_clip` now takes `Option<cutter::Reframe>` instead of `Option<Crop>`. `Reframe { canvas_w, canvas_h, strategy, anchor, pad_color, crop }` (serde `camelCase`) → `Reframe::to_filter()` → one of:

```
None      -> (no -vf)                        # identity, v1 cut
Simple(s) -> -vf {s}            + -map 0:v:0  # pad, crop, freeform
Complex(g)-> -filter_complex {g}+ -map [v]    # blur-fill
```

The blur graph: `[0:v]split=2[bg][fg]; [bg]scale=W:H:force_original_aspect_ratio=increase,crop=W:H,gblur=sigma=σ[bgb]; [fg]scale=W:H:force_original_aspect_ratio=decrease[fgs]; [bgb][fgs]overlay=x:y,setsar=1[v]` (σ scales with the canvas, clamped 10–40). Audio (`-map 0:a?`), frame-accurate `-ss`/`-t`, CRF 18, `+faststart`, and `time=` progress parsing are unchanged from v1.

### Frontend

- `src/reframe.ts` — pure helpers + shared types (`CanvasRatio`, `FillStrategy`, `Anchor`, `Reframe`); `canvasDims`, `canvasAspect`, `barsAxis`, `anchorObjectPosition`.
- `state.ts` — signals `reframeRatio`, `fillStrategy`, `reframeAnchor`, `padColor`; `chooseRatio()` (Freeform seeds + shows the crop overlay, presets clear it), `stageAspect()` (reshapes the preview), `buildReframe()` (`null` == identity).
- `components/ReframePanel.tsx` — the single aspect control: canvas chips, fill toggle, bar-color well, position. Replaces the old standalone Crop button.
- `components/VideoPlayer.tsx` — the stage **is** the live preview: it takes the canvas aspect, the foreground `<video>` is `contain`-fitted + anchored, and blur-fill adds a second muted, blurred backdrop `<video>` synced off the main element. Pad shows a solid backdrop. CSS-only mirror of the filtergraph; the export is unaffected.
- `CropOverlay.tsx` is still the crop rectangle, now reached via the `freeform` canvas (Step 2 will AR-lock it for manual crop-to-fill).

### Build milestones

Built in two milestones; **stop after Tier 1 for live testing** before Tier 2.

**Tier 1 — deterministic reframe.** Canvas presets, the three fill strategies, positioning, live preview, and hardware-encoder support. Sub-steps:
1. **(shipped)** Reframe model + `ReframePanel` + blur-fill + pad + live preview + Freeform crop (== v1). Backend `Reframe` filtergraph. Verified: `cargo test` (22, incl. 7 reframe), `cargo clippy -D warnings`, `tsc --noEmit`, `npm run build`. Needs live-window testing (see `progress.txt`).
2. **(shipped)** Manual crop-to-fill: "Crop" added to the preset fill toggle; `CropOverlay` AR-locked to the canvas (`cropAspectLock()` + aspect-locked corner resize); `buildReframe()` sends the rect so the backend does `crop,scale`. The editing view shows the **full source frame with the aspect-locked box** (not a canvas-shaped cover), so you can see what's cropped out; `stageAspect()` returns the source aspect while `cropMode()`. Frontend-only — the `crop,scale` backend path shipped in Step 1. Verified: `tsc --noEmit`, `npm run build`.
3. **(shipped)** Hardware encoders (folds in roadmap item 2). New `encoders.rs`: `VideoEncoder` enum + per-encoder quality flags, a **test-encode probe** (5 frames of `testsrc` → null with the real flags — because being *listed* in the build ≠ *usable*: nvenc needs an NVIDIA GPU, etc.), `detect()` → first working candidate else `X264`, cached per session in a Tauri-managed `tokio::OnceCell` ([`EncoderCache`]). Priority: macOS `h264_videotoolbox`; Windows `h264_nvenc` → `h264_qsv` → `h264_amf`. `cutter::cut` takes a `VideoEncoder`; `export_clip` gains `use_hardware`; `detect_encoder` returns the display name. UI: Auto/Software toggle in the export panel + the resolved encoder name. Any probe failure cascades to **libx264**, so correctness is guaranteed and only speed varies. HW quality knobs (`-q:v` / `-cq` / `-global_quality` / `-qp`) target CRF-18-equivalent and are flagged for live/CI tuning. Verified: `cargo test` (24), `cargo clippy -D warnings`, `tsc`, `npm run build`.

### Output formats (converter)

ClipSmith exports **MP4 by default** but can write **MOV**, **MKV**, or **WebM** — a built-in container/codec converter. Because the trim and reframe filtergraph are codec-agnostic (they hand off `yuv420p`), a format only changes the tail of the ffmpeg command: video codec, audio codec, and muxer. `formats.rs` owns this:

- **MP4 / MOV / MKV → H.264 + AAC.** These reuse the whole pipeline, including the `VideoEncoder` choice (libx264 or a detected hardware encoder). `+faststart` for mp4/mov only. Always available (libx264 ships).
- **WebM → VP9 + Opus.** A different codec path: hardware H.264 doesn't apply (VP9 is software `libvpx-vp9`, CRF 31), audio is Opus. It's **runtime-probed** (a VP9+Opus test-encode via `formats::available_cached`, cached in a Tauri `OnceCell`) and only offered when the bundled ffmpeg actually encodes it. Both platforms ship it: the Windows BtbN build bundles libvpx/libopus, and `scripts/build-ffmpeg-macos.sh` compiles static libvpx (native arm64 auto-detect; `x86_64-darwin20-gcc` + nasm for the cross) and libopus into the macOS sidecar. The probe is the safety net if a build ever drops them.

`OutputFormat::encode_args(encoder, output)` builds the video+audio+container+muxer+output tail; `cutter::cut` takes a `cutter::Encoding { format, encoder }`. `export_clip` takes a grouped `ExportOptions { reframe, format, useHardware }` (keeps the command under clippy's 7-arg limit) and only detects a hardware encoder for H.264 formats. Frontend: `src/formats.ts` (display metadata), `outputFormat` + `availableFormatIds` signals, a **Format** field of chips in the export panel (with a codec hint), and the Encoder field shown only for H.264 formats. The save dialog defaults to the chosen extension. **(shipped)**

### Security & hardening (v2)

A pre-1.0 security/logic audit added these guards (all covered by tests):

- **yt-dlp argument injection** — the import URL is validated to `http`/`https` (`is_http_url`), passed after a `--` end-of-options separator, and yt-dlp runs with `--ignore-config` (so a planted config can't inject `--exec` etc.) and `--max-filesize`. A `--flag`-shaped "URL" is rejected before it reaches yt-dlp.
- **Filtergraph injection** — `pad_color` is strictly validated to `#RRGGBB` → `0xRRGGBB` (else `black`), so no arbitrary text (a stray `,` would inject a second `-vf` filter) reaches the filtergraph.
- **Path/arg safety** — user paths handed to ffmpeg/ffprobe are rejected if they start with `-` (`reject_flaglike`); `default_save_path` sanitizes the suggested filename to its final component (`safe_filename`) so it can't escape the exports folder.
- **Download limits** — both the direct fetch and yt-dlp cap the size (`MAX_DOWNLOAD_BYTES` / `--max-filesize`) as a runaway-disk guard.
- **Error fidelity** — the export keeps a bounded tail of *all* ffmpeg stderr (not just non-progress lines) so a real failure reason isn't swallowed when a chunk also carries a `time=` update.

Frontend fixes: export result/error state is cleared on a direct video switch; the blur-backdrop `<video>` is only driven while mounted; `seekTo` can't go negative before metadata resolves; the aspect-locked crop resize (extracted to `reframe.ts` `lockedCropResize`, unit-tested) won't collapse below the minimum near a frame edge. The export now has a success state ("Saved ✓" + reveal-in-folder via `opener:allow-reveal-item-in-dir`).

Known/accepted: `tauri.conf.json` keeps `csp: null` and a broad `assetProtocol.scope` — the app plays arbitrary local videos through the asset protocol and loads no remote content, so a strict CSP is a deferred hardening item rather than a shipped one (getting media-src wrong silently breaks playback on a platform that can't be dev-tested here).

**Tier 2 — subject-aware crop-to-fill.** The first feature that must *understand* the video, so treat it like CaptionSmith's whisper integration, not a filter. Bundled local face detector via ONNX Runtime (`ort`, MIT) — **not** Ultralytics YOLO (AGPL). Two-phase like transcription: a cancellable **analyze** pass samples frames, runs detection, and builds a temporally-smoothed (low-pass/eased) center-path; the **encode** then drives a time-varying `crop`. Pan smoothly within a shot; **hard-cut** across scene changes (detect cheaply with `select='gt(scene,…)'`); on no detection, hold last position / center (never lurch). Ideally the smoothed path is previewable and nudgeable before committing.

### Conventions specific to v2

- Spawn FFmpeg via the existing `cutter.rs` shell-plugin `.spawn()` streaming path (text stderr → `time=` progress). The `std::process::Command` / `set_raw_out(true)` gotcha (plugins-workspace #3090) only affects **binary** stdout (e.g. `filmstrip.rs` piping a PNG); it does not apply to text-stderr progress, so reframe reuses the working `cutter.rs` pattern rather than a parallel spawn mechanism.
- Canvas dimensions are computed once in TS and passed to Rust; the backend defensively re-evens them but does not recompute the ratio. Keep this single-source-of-truth split so preview == export.
- Don't reintroduce a second aspect/crop picker. Crop is a *mode of* reframe.
