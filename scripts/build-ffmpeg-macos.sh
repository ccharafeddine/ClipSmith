#!/usr/bin/env bash
#
# build-ffmpeg-macos.sh — compile a minimal LGPL ffmpeg + ffprobe from source
# for the host macOS architecture, and place them in src-tauri/binaries/ with
# the Rust host target-triple suffix Tauri's externalBin bundler expects.
#
# Why compile instead of download: no LGPL static macOS build is published, and
# evermeet.cx (and most prebuilts) are GPL because they bundle libx264, which
# would relicense ClipSmith (MIT) to GPL. Configuring with --disable-gpl /
# --disable-nonfree keeps the build LGPL-clean.
#
# ClipSmith simple mode never encodes video — it stream-copies (`ffmpeg -c copy`)
# and builds timeline thumbnails (decode + the built-in PNG encoder via
# image2pipe). All of that is covered by FFmpeg's built-in (native) codecs,
# muxers, and filters, so this build enables no external libraries and links only
# macOS system frameworks, staying portable across Macs. No hardware encoder is
# needed (that's an advanced-mode concern; see CLAUDE.md).
#
# Run on a macOS host whose native arch matches the target you want (Apple
# Silicon -> aarch64-apple-darwin, Intel -> x86_64-apple-darwin). Requires the
# Xcode command line tools, plus `nasm` for x86_64 asm (brew install nasm).

set -euo pipefail

FFMPEG_VERSION="${FFMPEG_VERSION:-7.1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="$REPO_ROOT/src-tauri/binaries"
TRIPLE="$(rustc -vV | sed -n 's/host: //p')"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "error: this script must run on macOS (host is $(uname -s))" >&2
  exit 1
fi

mkdir -p "$BIN_DIR"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

echo "Downloading ffmpeg ${FFMPEG_VERSION} source..."
curl -fL --retry 3 -o ffmpeg.tar.xz \
  "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"
tar xf ffmpeg.tar.xz
cd "ffmpeg-${FFMPEG_VERSION}"

echo "Configuring (LGPL: --disable-gpl, no external/nonfree libs)..."
./configure \
  --prefix="$WORK/out" \
  --disable-gpl \
  --disable-nonfree \
  --disable-doc \
  --disable-ffplay \
  --disable-debug \
  --enable-pic

make -j"$(sysctl -n hw.ncpu)"
make install

# Belt-and-suspenders: refuse to ship a binary that somehow advertises GPL.
if "$WORK/out/bin/ffmpeg" -hide_banner -buildconf | grep -q -- '--enable-gpl'; then
  echo "error: built ffmpeg reports --enable-gpl; refusing (ClipSmith is LGPL-only)" >&2
  exit 1
fi

cp "$WORK/out/bin/ffmpeg" "$BIN_DIR/ffmpeg-${TRIPLE}"
cp "$WORK/out/bin/ffprobe" "$BIN_DIR/ffprobe-${TRIPLE}"
chmod +x "$BIN_DIR/ffmpeg-${TRIPLE}" "$BIN_DIR/ffprobe-${TRIPLE}"

echo "Built LGPL ffmpeg + ffprobe for ${TRIPLE}:"
"$BIN_DIR/ffmpeg-${TRIPLE}" -hide_banner -version | head -1
echo "  -> ffmpeg-${TRIPLE}"
echo "  -> ffprobe-${TRIPLE}"
