#!/usr/bin/env bash
#
# fetch-ffmpeg.sh — download LGPL FFmpeg + ffprobe sidecars for ClipSmith.
#
# Places binaries in src-tauri/binaries/ named {name}-{target-triple}, the
# layout Tauri's externalBin / sidecar mechanism requires.
#
# ClipSmith simple mode only ever stream-copies (`ffmpeg -c copy`); it never
# invokes a video encoder. An LGPL build (no GPL libx264) is therefore both
# sufficient and required — a GPL build would force the whole app to GPL.
#
# Windows: BtbN's static "lgpl" release — one self-contained .exe, no DLLs.
# macOS:   no LGPL prebuilt exists, so it's compiled from source with
#          --disable-gpl by scripts/build-ffmpeg-macos.sh (invoked here when run
#          on a Mac, and by CI on macOS runners).
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$SCRIPT_DIR/../src-tauri/binaries"
mkdir -p "$BIN_DIR"

WIN_TRIPLE="x86_64-pc-windows-msvc"
MAC_TRIPLES=("x86_64-apple-darwin" "aarch64-apple-darwin")

# BtbN auto-build: the "lgpl" variant is configured WITHOUT --enable-gpl.
BTBN_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip"

have() { command -v "$1" >/dev/null 2>&1; }

extract_zip() {
  # $1 = zip path, $2 = destination dir
  if have unzip; then
    unzip -q -o "$1" -d "$2"
  elif have tar; then
    # Windows 10+/macOS/Linux bsdtar can unpack zips.
    tar -xf "$1" -C "$2"
  else
    echo "error: need 'unzip' or 'tar' to extract archives" >&2
    return 1
  fi
}

fetch_windows() {
  echo "==> Windows ($WIN_TRIPLE): BtbN static LGPL build"
  local tmp zip src
  tmp="$(mktemp -d)"
  zip="$tmp/ffmpeg-win64-lgpl.zip"

  echo "    downloading $BTBN_URL"
  curl -fL --retry 3 -o "$zip" "$BTBN_URL"
  extract_zip "$zip" "$tmp"

  # Archive layout: ffmpeg-master-latest-win64-lgpl/bin/{ffmpeg,ffprobe}.exe
  src="$(dirname "$(find "$tmp" -name 'ffmpeg.exe' -print -quit)")"
  [ -n "$src" ] && [ -f "$src/ffmpeg.exe" ] || {
    echo "error: ffmpeg.exe not found inside the downloaded archive" >&2
    return 1
  }

  # Guard the LGPL-only constraint: refuse any build that advertises GPL.
  # Only runnable when the host can execute a Windows .exe (i.e. on Windows).
  if "$src/ffmpeg.exe" -version >/dev/null 2>&1; then
    if "$src/ffmpeg.exe" -hide_banner -buildconf 2>&1 | grep -q -- '--enable-gpl'; then
      echo "error: build reports --enable-gpl; refusing (ClipSmith is LGPL-only)" >&2
      return 1
    fi
    echo "    verified: build has no --enable-gpl"
  else
    echo "    note: cannot exec ffmpeg.exe on this host; skipping GPL self-check"
  fi

  cp "$src/ffmpeg.exe"  "$BIN_DIR/ffmpeg-$WIN_TRIPLE.exe"
  cp "$src/ffprobe.exe" "$BIN_DIR/ffprobe-$WIN_TRIPLE.exe"
  rm -rf "$tmp"
  echo "    -> ffmpeg-$WIN_TRIPLE.exe"
  echo "    -> ffprobe-$WIN_TRIPLE.exe"
}

fetch_macos() {
  # No turnkey LGPL static macOS FFmpeg build is published (evermeet.cx etc. are
  # GPL, bundling libx264), so macOS sidecars are COMPILED FROM SOURCE with
  # --disable-gpl. That requires the macOS toolchain, so it only runs on a Mac.
  if [ "$(uname -s)" = "Darwin" ]; then
    echo "==> macOS: compiling LGPL FFmpeg from source"
    bash "$SCRIPT_DIR/build-ffmpeg-macos.sh"
  else
    echo "==> macOS (${MAC_TRIPLES[*]}): skipped on this $(uname -s) host"
    cat >&2 <<'EOF'
    macOS sidecars are built LGPL from source by scripts/build-ffmpeg-macos.sh,
    which needs the macOS toolchain. Run this script (or that one) on a Mac to
    produce them; CI builds them on macOS runners (.github/workflows/release.yml).
EOF
  fi
}

main() {
  fetch_windows
  echo
  fetch_macos
  echo
  echo "Done. Contents of src-tauri/binaries/:"
  ls -la "$BIN_DIR" | sed '1d'
}

main "$@"
