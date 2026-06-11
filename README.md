<p align="center">
  <img src="src/assets/clipsmith-icon.svg" width="128" alt="ClipSmith" />
</p>

<h1 align="center">ClipSmith</h1>

<p align="center">Cut a clip out of any video — losslessly, with the audio and every other stream intact.</p>

---

ClipSmith is a small, fast desktop app for Mac and Windows. Open a local video
(or paste a URL — YouTube and other sites work), scrub a timeline to pick start
and end points, and export a trimmed clip. The cut is **lossless**: it
stream-copies the selected range with no re-encoding, so the output is
bit-identical to the source and the export is near-instant. It's local-first: no
accounts, no media library, no telemetry, no ads. A local video is read in place
and never imported or copied. The only feature that touches the network is URL
import, which downloads the video to a temp file (deleted when you quit); the
only file kept on disk is the clip you export.

Built with [Tauri](https://v2.tauri.app) and [SolidJS](https://www.solidjs.com),
with a bundled LGPL build of [FFmpeg](https://ffmpeg.org) for probing and the cut.
There is no encoder and no in-process media library — the entire "engine" is a
single `ffmpeg -c copy` subprocess.

<!-- Screenshots go here. -->

## How the lossless cut works

This is the heart of ClipSmith, and the one behavior worth understanding up front.

A stream copy (`ffmpeg -c copy`) can only begin on a **keyframe** — a frame that
stands on its own without referencing others. So ClipSmith reads the video's
keyframe timestamps when you open it, shows them as subtle ticks on the timeline,
and makes the **start (IN) handle magnetic**: it snaps to the nearest keyframe at
or before where you drop it. The **end (OUT) handle is free** — only the start has
to land on a keyframe.

That start-point snapping is **intentional, not a bug**. It's the price of a cut
that is instant and perfectly lossless: no frames are decoded or re-encoded, so
the clip is bit-identical to the source and **no video encoder is ever invoked**
(which is also what keeps the app license clean — see
[licensing](#bundled-binaries--licensing)). The output container always matches
the source (`.mp4`→`.mp4`, `.mkv`→`.mkv`, …) so the copy always succeeds, and the
clip keeps **every stream**: video, audio, subtitles, and attachments.

Because a lossless cut is exactly what the player already shows looping between
the handles, **the player is the preview** — there's no separate re-export step.

## Features

- Open `mp4`, `mov`, `mkv`, `webm`, `avi`, `m4v` via file picker
- **Import from a URL** — paste a YouTube (or other site) link and ClipSmith
  fetches the video with a bundled [yt-dlp](https://github.com/yt-dlp/yt-dlp);
  direct links to a video file are downloaded over plain HTTP. A progress bar
  and Cancel button show while it downloads. Video and audio are kept.
- A timeline with **filmstrip thumbnails** and iOS-style trim handles,
  **zoomable** (scroll to zoom, cursor-anchored) for frame-accurate end points
- **Magnetic keyframe snapping** on the start handle, with keyframe **ticks** on
  the timeline; the end handle is free
- **Lossless stream-copy** export — near-instant, bit-identical, keeps audio and
  all other streams; output container matches the source
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
| `I` | Set the clip start (IN) at the playhead (snaps to the nearest keyframe) |
| `O` | Set the clip end (OUT) at the playhead |
| Scroll over the timeline | Zoom in / out (cursor-anchored) |

## Install

Download the latest installer from the
[Releases](https://github.com/ccharafeddine/ClipSmith/releases) page:

- **Windows**: the `.msi`. Windows SmartScreen may warn on an unsigned app;
  choose **More info → Run anyway**.
- **macOS**: the `.dmg` for your chip (Apple Silicon or Intel). The app is
  unsigned, so the first launch needs the Gatekeeper workaround:

  > **Right-click** (or Control-click) the app in Applications → **Open** →
  > **Open** again in the dialog. You only need to do this once.

## Build from source

Prerequisites: [Node.js](https://nodejs.org) 20+ and the
[Rust toolchain](https://rustup.rs).

```bash
npm install

# Provide the bundled FFmpeg/ffprobe sidecars, placed in src-tauri/binaries
# with the per-target-triple names Tauri expects.
bash scripts/fetch-ffmpeg.sh        # Windows: BtbN LGPL static build
bash scripts/build-ffmpeg-macos.sh  # macOS: compile an LGPL build from source
                                    # (needs Xcode CLT + `brew install nasm`)

# Provide the bundled yt-dlp sidecar for URL import (refresh before each release;
# yt-dlp goes stale as sites change their players).
bash scripts/fetch-ytdlp.sh

# Run in development
npm run tauri dev

# Produce a production build for the current platform
npm run tauri build
```

On macOS there's no published LGPL static FFmpeg, so the sidecars are compiled
from source with `--disable-gpl`; on a Mac, `bash scripts/fetch-ffmpeg.sh`
delegates to the build script for you. CI builds both platforms on a tag push
(see `.github/workflows/release.yml`).

## Bundled binaries & licensing

ClipSmith is MIT licensed. The binaries it bundles are invoked as separate
sidecar processes (never linked into the app), and keep their own licenses:

- **FFmpeg** (LGPL), used for probing, keyframe listing, timeline thumbnails, and
  the `-c copy` cut. Windows uses the LGPL static build from
  [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds); macOS is compiled
  from the official [FFmpeg](https://ffmpeg.org/download.html) source with
  `--disable-gpl --disable-nonfree` (no LGPL static macOS build is published).
  Simple mode **never invokes a video encoder** — it only stream-copies — so no
  GPL encoder (e.g. `libx264`) is ever touched, which is what keeps the
  distribution LGPL/MIT clean. Source: <https://ffmpeg.org/download.html>.
- **yt-dlp** (Unlicense / public domain), used only for URL import. Bundled as a
  sidecar and refreshed per release via `scripts/fetch-ytdlp.sh`. Public domain,
  so it's MIT-compatible to ship. Source: <https://github.com/yt-dlp/yt-dlp>.
- **Font**: Syne (SIL Open Font License), bundled in `src/assets/fonts` with its
  license file. No web-font requests are made.

## Roadmap

Simple mode is deliberately lossless and ships first. A future **advanced mode**
will add frame-accurate cutting (re-encode), smart-cut, format conversion, and
more — all while keeping simple mode pristine and lossless.

## License

[MIT](LICENSE) © Chafic Charafeddine. Bundled FFmpeg is LGPL, as noted above.
