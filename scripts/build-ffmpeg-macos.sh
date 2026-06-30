#!/usr/bin/env bash
#
# build-ffmpeg-macos.sh — compile a GPL ffmpeg + ffprobe (with a STATIC libx264)
# from source for BOTH macOS architectures (arm64 native + x86_64 cross), then
# lipo them into a universal binary. A Tauri universal-apple-darwin build needs
# THREE sidecar names per tool: the two per-arch `binaries/<name>-{aarch64,
# x86_64}-apple-darwin` (resolved by each per-arch sub-build) and the fat
# `binaries/<name>-universal-apple-darwin` (copied at the final bundle; Tauri does
# not lipo the pair itself). So we keep both per-arch binaries AND the universal.
#
# Why compile instead of download: ClipSmith re-encodes every export with libx264
# (frame-accurate cuts + crop), and no suitable static GPL macOS build is
# published. Building libx264 statically and linking it in keeps each ffmpeg
# sidecar self-contained, depending only on macOS system frameworks — portable
# across Macs, no Homebrew dylib path baked in. libx264 is GPL, so this is
# --enable-gpl (that is what makes ClipSmith GPL; see LICENSE). --enable-
# videotoolbox keeps the system H.264 encoder available for the playback proxy.
#
# Building a universal binary on the Apple Silicon runner avoids the scarce,
# deprecated macos-13 Intel runner entirely (it tends to sit queued forever).
#
# Run on an Apple Silicon macOS host: the arm64 build is native, the x86_64 build
# cross-compiles via `clang -arch x86_64`. Requires Xcode CLT + `brew install
# nasm` (x264/ffmpeg x86 asm).

set -euo pipefail

FFMPEG_VERSION="${FFMPEG_VERSION:-7.1}"
# x264 ships no versioned release tarballs; the "stable" branch snapshot is what
# everyone packages.
X264_TARBALL="${X264_TARBALL:-https://code.videolan.org/videolan/x264/-/archive/stable/x264-stable.tar.bz2}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="$REPO_ROOT/src-tauri/binaries"
UNIVERSAL_TRIPLE="universal-apple-darwin"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "error: this script must run on macOS (host is $(uname -s))" >&2
  exit 1
fi

mkdir -p "$BIN_DIR"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

echo "Downloading x264 source..."
curl -fL --retry 3 -o x264.tar.bz2 "$X264_TARBALL"
mkdir x264-src
tar xf x264.tar.bz2 -C x264-src --strip-components=1
X264_SRC="$WORK/x264-src"

echo "Downloading ffmpeg ${FFMPEG_VERSION} source..."
curl -fL --retry 3 -o ffmpeg.tar.xz \
  "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"
tar xf ffmpeg.tar.xz
FFMPEG_SRC="$WORK/ffmpeg-${FFMPEG_VERSION}"

# Build a static libx264 then ffmpeg/ffprobe against it, for one arch, and copy
# the tools into BIN_DIR under the matching Rust target triple. $1 = short label,
# $2 = target triple, $3 = "cross" for the non-host arch (empty for native).
build_arch() {
  local label="$1" triple="$2" mode="${3:-}"
  local prefix="$WORK/deps-${label}"        # static libx264 install prefix
  local xbuild="$WORK/x264-build-${label}"
  local fbuild="$WORK/ffmpeg-build-${label}"

  echo "=== [$label] building static libx264 ==="
  # x264 builds in-tree; use a fresh copy per arch so configs don't collide.
  cp -R "$X264_SRC" "$xbuild"
  cd "$xbuild"
  local x264_flags=(--prefix="$prefix" --enable-static --disable-cli --enable-pic)
  if [ "$mode" = "cross" ]; then
    # Cross to x86_64 on an arm64 host: target via --host + an x86_64 clang.
    CC="clang -arch x86_64" ./configure "${x264_flags[@]}" \
      --host=x86_64-apple-darwin
  else
    ./configure "${x264_flags[@]}"
  fi
  make -j"$(sysctl -n hw.ncpu)"
  make install

  echo "=== [$label] building ffmpeg (GPL + static libx264 + videotoolbox) ==="
  mkdir -p "$fbuild"
  cd "$fbuild"
  local ff_flags=(
    --prefix="$fbuild/out"
    --enable-gpl
    --enable-libx264
    --enable-videotoolbox
    --pkg-config-flags=--static
    --extra-cflags="-I$prefix/include"
    --extra-ldflags="-L$prefix/lib"
    --disable-nonfree
    --disable-doc
    --disable-ffplay
    --disable-debug
    --enable-pic
  )
  if [ "$mode" = "cross" ]; then
    ff_flags+=(
      --enable-cross-compile
      --arch=x86_64
      --target-os=darwin
      --cc="clang -arch x86_64"
      --extra-ldflags="-arch x86_64 -L$prefix/lib"
    )
  fi
  PKG_CONFIG_PATH="$prefix/lib/pkgconfig" "$FFMPEG_SRC/configure" "${ff_flags[@]}"
  make -j"$(sysctl -n hw.ncpu)"
  make install

  # Each per-arch binary must include libx264 and must not link a dynamic x264
  # (otool inspects any mach-o regardless of host arch).
  if ! "$fbuild/out/bin/ffmpeg" -hide_banner -buildconf | grep -q -- '--enable-libx264'; then
    echo "error: [$label] ffmpeg lacks --enable-libx264" >&2
    exit 1
  fi
  if otool -L "$fbuild/out/bin/ffmpeg" | grep -qi 'x264'; then
    echo "error: [$label] ffmpeg links a dynamic libx264; static link failed" >&2
    otool -L "$fbuild/out/bin/ffmpeg" | grep -i 'x264' >&2
    exit 1
  fi

  local tool
  for tool in ffmpeg ffprobe; do
    cp "$fbuild/out/bin/${tool}" "$BIN_DIR/${tool}-${triple}"
    chmod +x "$BIN_DIR/${tool}-${triple}"
  done
  echo "[$label] built ffmpeg + ffprobe for ${triple}."
  cd "$WORK"
}

# Native arm64, then cross x86_64.
build_arch "arm64" "aarch64-apple-darwin"
build_arch "x86_64" "x86_64-apple-darwin" "cross"

# Fuse the per-arch binaries into one fat universal binary named for the
# universal target triple — what Tauri's final bundle step copies.
for tool in ffmpeg ffprobe; do
  out="$BIN_DIR/${tool}-${UNIVERSAL_TRIPLE}"
  lipo -create \
    "$BIN_DIR/${tool}-aarch64-apple-darwin" \
    "$BIN_DIR/${tool}-x86_64-apple-darwin" \
    -output "$out"
  chmod +x "$out"
  echo "lipo'd universal ${tool}:"
  lipo -info "$out"
done

echo "All macOS ffmpeg/ffprobe sidecars:"
ls -la "$BIN_DIR"/ffmpeg-*-apple-darwin "$BIN_DIR"/ffprobe-*-apple-darwin
