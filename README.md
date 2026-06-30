<p align="center">
  <img src="src/assets/clipsmith-icon.svg" width="128" alt="ClipSmith" />
</p>

<h1 align="center">ClipSmith</h1>

<p align="center">Cut a clip out of any video — frame-accurate, with an optional crop.</p>

---

ClipSmith is a small, fast desktop app for Mac and Windows. Open a local video
(or paste a URL — YouTube and other sites work), scrub a timeline to pick start
and end points, optionally crop the frame, and export a trimmed clip. The cut is
**frame-accurate**: ClipSmith re-encodes the selected range with H.264 so the IN
and OUT points land exactly where you put them — no snapping to keyframes. It's
local-first: no accounts, no media library, no telemetry, no ads. A local video
is read in place and never imported or copied. The only feature that touches the
network is URL import, which downloads the video to a temp file (deleted when you
quit); the only file kept on disk is the clip you export.

Built with [Tauri](https://v2.tauri.app) and [SolidJS](https://www.solidjs.com),
with a bundled GPL build of [FFmpeg](https://ffmpeg.org) (including `libx264`) for
probing, thumbnails, and the cut.

<!-- Screenshots go here. -->

## How the cut works

ClipSmith re-encodes the selected range to an **H.264 / AAC `.mp4`** with
`libx264`. Because every frame is decoded and re-encoded, the start and end
points are exact to the frame — drag the handles anywhere, no keyframe snapping,
no dead zones you can't trim through. If you set a **crop**, the rectangle is
applied during the same pass.

The trade-off versus a pure stream copy is that the export is not instant and not
bit-identical to the source; it re-compresses at a high quality target (CRF 18,
`preset medium`, visually near-lossless). A progress bar shows while it encodes.

The output is always `.mp4` regardless of the source container, since H.264
doesn't fit every container (e.g. `.webm`) and a crop rewrites the pixels anyway.
The first video stream and all audio are kept; subtitles and attachments are not
carried into the re-encoded mp4.

## Features

- Open `mp4`, `mov`, `mkv`, `webm`, `avi`, `m4v` via file picker
- **Import from a URL** — paste a YouTube (or other site) link and ClipSmith
  fetches the video with a bundled [yt-dlp](https://github.com/yt-dlp/yt-dlp);
  direct links to a video file are downloaded over plain HTTP. A progress bar
  and Cancel button show while it downloads. Video and audio are kept.
- A timeline with **filmstrip thumbnails** and iOS-style trim handles,
  **zoomable** (scroll to zoom, cursor-anchored). **Both handles are free and
  frame-accurate** — drop them wherever you want.
- **Crop** — toggle a draggable, resizable rectangle over the video to crop the
  output frame
- **Frame-accurate H.264/AAC mp4 export** with a real progress bar; keeps the
  first video stream and all audio
- Exports default to an **Exports folder** (`<Documents>/ClipSmith/Exports`),
  created on first export — the save dialog opens there with the name prefilled,
  and you can still save anywhere
- Looping playback between the trim handles, with the audio kept intact (the
  player doubles as the preview)
- **Clear** the loaded video without opening another
- Dark, minimal interface
- Native binaries for macOS and Windows

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `←` / `→` | Step one source frame |
| `I` | Set the clip start (IN) at the playhead |
| `O` | Set the clip end (OUT) at the playhead |
| Scroll over the timeline | Zoom in / out (cursor-anchored) |

## Install

Download the latest installer from the
[Releases](https://github.com/ccharafeddine/ClipSmith/releases) page:

- **Windows**: the `.msi`. Windows SmartScreen may warn on an unsigned app;
  choose **More info → Run anyway**.
- **macOS**: the `.dmg` (one universal build runs on both Apple Silicon and
  Intel). The app is unsigned, so the first launch needs the Gatekeeper
  workaround:

  > **Right-click** (or Control-click) the app in Applications → **Open** →
  > **Open** again in the dialog. You only need to do this once.

## Build from source

Prerequisites: [Node.js](https://nodejs.org) 20+ and the
[Rust toolchain](https://rustup.rs).

```bash
npm install

# Provide the bundled FFmpeg/ffprobe sidecars, placed in src-tauri/binaries
# with the per-target-triple names Tauri expects.
bash scripts/fetch-ffmpeg.sh        # Windows: BtbN GPL static build (libx264)
bash scripts/build-ffmpeg-macos.sh  # macOS: compile GPL FFmpeg + static libx264
                                    # (needs Xcode CLT + `brew install nasm`)

# Provide the bundled yt-dlp sidecar for URL import (refresh before each release;
# yt-dlp goes stale as sites change their players).
bash scripts/fetch-ytdlp.sh

# Run in development
npm run tauri dev

# Produce a production build for the current platform
npm run tauri build
```

On macOS there's no suitable static GPL FFmpeg, so the sidecars are compiled from
source with `--enable-gpl --enable-libx264` against a statically built `libx264`;
on a Mac, `bash scripts/fetch-ffmpeg.sh` delegates to the build script for you.
CI builds both platforms on a tag push (see `.github/workflows/release.yml`).

## Bundled binaries & licensing

ClipSmith is **GPL-3.0** licensed. It re-encodes with `libx264`, which is GPL;
combining it makes the whole app GPL (the standard situation for open-source
video tools like HandBrake, Shotcut, and OBS). The binaries it bundles are
invoked as separate sidecar processes:

- **FFmpeg** (GPL, with `libx264`), used for probing, timeline thumbnails, and the
  H.264 re-encode. Windows uses the GPL static build from
  [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds); macOS is compiled
  from the official [FFmpeg](https://ffmpeg.org/download.html) source with
  `--enable-gpl --enable-libx264` against a static `libx264`. Source:
  <https://ffmpeg.org/download.html>.
- **yt-dlp** (Unlicense / public domain), used only for URL import. Bundled as a
  sidecar and refreshed per release via `scripts/fetch-ytdlp.sh`. Source:
  <https://github.com/yt-dlp/yt-dlp>.
- **Font**: Syne (SIL Open Font License), bundled in `src/assets/fonts` with its
  license file. No web-font requests are made.

## Roadmap

Possible next steps: export-quality presets (CRF / resolution), hardware-encoder
options, multiple clips and concatenation, filters, and a multi-track timeline.

## License

[GPL-3.0](LICENSE) © Chafic Charafeddine. Bundled FFmpeg is GPL (with `libx264`),
as noted above.
