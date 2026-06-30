#!/usr/bin/env bash
#
# build-ffmpeg-macos.sh — compile a GPL ffmpeg + ffprobe (with a STATIC libx264)
# from source for the host macOS architecture, and place them in
# src-tauri/binaries/ with the Rust host target-triple suffix Tauri's externalBin
# bundler expects.
#
# Why compile instead of download: ClipSmith re-encodes every export with libx264
# (frame-accurate cuts + crop), and no suitable static GPL macOS build is
# published. Building libx264 statically and linking it in keeps the ffmpeg
# sidecar a single self-contained binary that depends only on macOS system
# frameworks — portable across Macs, no Homebrew dylib path baked in.
#
# libx264 is GPL, so this build is configured --enable-gpl. That is what makes
# ClipSmith a GPL app (see LICENSE); it is intentional, not a mistake.
#
# Run on a macOS host whose native arch matches the target you want (Apple
# Silicon -> aarch64-apple-darwin, Intel -> x86_64-apple-darwin). Requires the
# Xcode command line tools, plus `nasm` for asm (brew install nasm). x264 is
# built from source here, so Homebrew's x264 is NOT required.

set -euo pipefail

FFMPEG_VERSION="${FFMPEG_VERSION:-7.1}"
# x264 has no stable release tarballs; its master "stable" branch is what
# everyone ships. Pin via the source tree's snapshot tarball from videolan.
X264_TARBALL="${X264_TARBALL:-https://code.videolan.org/videolan/x264/-/archive/stable/x264-stable.tar.bz2}"
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
PREFIX="$WORK/deps"   # static libx264 install prefix (headers + libx264.a)
cd "$WORK"

# ---- 1. Build a static libx264 ------------------------------------------------
echo "Downloading x264 source..."
curl -fL --retry 3 -o x264.tar.bz2 "$X264_TARBALL"
mkdir x264-src
tar xf x264.tar.bz2 -C x264-src --strip-components=1
cd x264-src
echo "Configuring x264 (static, no CLI)..."
./configure \
  --prefix="$PREFIX" \
  --enable-static \
  --disable-cli \
  --enable-pic
make -j"$(sysctl -n hw.ncpu)"
make install
cd "$WORK"

# ---- 2. Build ffmpeg/ffprobe against the static libx264 -----------------------
echo "Downloading ffmpeg ${FFMPEG_VERSION} source..."
curl -fL --retry 3 -o ffmpeg.tar.xz \
  "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"
tar xf ffmpeg.tar.xz
cd "ffmpeg-${FFMPEG_VERSION}"

echo "Configuring ffmpeg (GPL + static libx264)..."
# Point pkg-config at our static x264 so --enable-libx264 links libx264.a, not a
# Homebrew dylib. --pkg-config-flags=--static pulls x264's static deps too.
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
./configure \
  --prefix="$WORK/out" \
  --enable-gpl \
  --enable-libx264 \
  --pkg-config-flags=--static \
  --extra-cflags="-I$PREFIX/include" \
  --extra-ldflags="-L$PREFIX/lib" \
  --disable-nonfree \
  --disable-doc \
  --disable-ffplay \
  --disable-debug \
  --enable-pic

make -j"$(sysctl -n hw.ncpu)"
make install

# Sanity: the build must actually include libx264, and the binary must not link a
# non-system dylib for it (otherwise it won't run on a clean Mac).
if ! "$WORK/out/bin/ffmpeg" -hide_banner -buildconf | grep -q -- '--enable-libx264'; then
  echo "error: built ffmpeg lacks --enable-libx264; refusing (ClipSmith re-encodes H.264)" >&2
  exit 1
fi
if otool -L "$WORK/out/bin/ffmpeg" | grep -qi 'x264'; then
  echo "error: ffmpeg links a dynamic libx264; the static link did not take" >&2
  otool -L "$WORK/out/bin/ffmpeg" | grep -i 'x264' >&2
  exit 1
fi

cp "$WORK/out/bin/ffmpeg" "$BIN_DIR/ffmpeg-${TRIPLE}"
cp "$WORK/out/bin/ffprobe" "$BIN_DIR/ffprobe-${TRIPLE}"
chmod +x "$BIN_DIR/ffmpeg-${TRIPLE}" "$BIN_DIR/ffprobe-${TRIPLE}"

echo "Built GPL ffmpeg + ffprobe (static libx264) for ${TRIPLE}:"
"$BIN_DIR/ffmpeg-${TRIPLE}" -hide_banner -version | head -1
echo "  -> ffmpeg-${TRIPLE}"
echo "  -> ffprobe-${TRIPLE}"
