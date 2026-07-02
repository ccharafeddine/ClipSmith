#!/usr/bin/env bash
#
# build-ffmpeg-macos.sh — compile a GPL ffmpeg + ffprobe from source for BOTH
# macOS architectures (arm64 native + x86_64 cross), then lipo them into a
# universal binary. Statically links libx264 (H.264 export), plus libvpx (VP9)
# and libopus so the WebM output format works on macOS too — matching the
# prebuilt Windows sidecar. libvpx/libopus are BSD-licensed, so they don't
# change the GPL status (that comes from libx264; see LICENSE).
#
# A Tauri universal-apple-darwin build needs
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
# VP9 (video) + Opus (audio) for the WebM output format. Both BSD-licensed.
OPUS_VERSION="${OPUS_VERSION:-1.5.2}"
VPX_VERSION="${VPX_VERSION:-1.14.1}"
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

echo "Downloading opus ${OPUS_VERSION} source..."
curl -fL --retry 3 -o opus.tar.gz \
  "https://downloads.xiph.org/releases/opus/opus-${OPUS_VERSION}.tar.gz"
mkdir opus-src
tar xf opus.tar.gz -C opus-src --strip-components=1
OPUS_SRC="$WORK/opus-src"

echo "Downloading libvpx ${VPX_VERSION} source..."
curl -fL --retry 3 -o libvpx.tar.gz \
  "https://github.com/webmproject/libvpx/archive/refs/tags/v${VPX_VERSION}.tar.gz"
mkdir vpx-src
tar xf libvpx.tar.gz -C vpx-src --strip-components=1
VPX_SRC="$WORK/vpx-src"

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

  echo "=== [$label] building static libopus ==="
  # Opus uses autotools, so cross-compiles the same way x264 does (--host + an
  # x86_64 clang). In-tree build, so use a fresh copy per arch.
  local opusbuild="$WORK/opus-build-${label}"
  cp -R "$OPUS_SRC" "$opusbuild"
  cd "$opusbuild"
  local opus_flags=(
    --prefix="$prefix"
    --enable-static
    --disable-shared
    --disable-doc
    --disable-extra-programs
  )
  if [ "$mode" = "cross" ]; then
    CC="clang -arch x86_64" ./configure "${opus_flags[@]}" --host=x86_64-apple-darwin
  else
    ./configure "${opus_flags[@]}"
  fi
  make -j"$(sysctl -n hw.ncpu)"
  make install

  echo "=== [$label] building static libvpx (VP9) ==="
  # libvpx has its own configure and builds out-of-tree. For native arm64 we let
  # it auto-detect the platform (modern libvpx detects arm64 macOS correctly),
  # dodging the brittle versioned target string; for the x86_64 cross we must
  # name the target and point it at an x86_64 clang + nasm (already installed).
  local vpxbuild="$WORK/vpx-build-${label}"
  mkdir -p "$vpxbuild"
  cd "$vpxbuild"
  local vpx_flags=(
    --prefix="$prefix"
    --enable-static
    --disable-shared
    --enable-pic
    --enable-vp9
    --enable-vp8
    --disable-examples
    --disable-tools
    --disable-docs
    --disable-unit-tests
  )
  if [ "$mode" = "cross" ]; then
    CC="clang -arch x86_64" "$VPX_SRC/configure" "${vpx_flags[@]}" \
      --target=x86_64-darwin20-gcc --as=nasm --extra-cflags="-arch x86_64"
  else
    "$VPX_SRC/configure" "${vpx_flags[@]}"
  fi
  make -j"$(sysctl -n hw.ncpu)"
  make install

  echo "=== [$label] building ffmpeg (GPL + static libx264/libvpx/libopus) ==="
  mkdir -p "$fbuild"
  cd "$fbuild"
  local ff_flags=(
    --prefix="$fbuild/out"
    --enable-gpl
    --enable-libx264
    --enable-libvpx
    --enable-libopus
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

  # Each per-arch binary must include libx264/libvpx/libopus and must not link
  # any of them dynamically (otool inspects any mach-o regardless of host arch).
  local buildconf
  buildconf="$("$fbuild/out/bin/ffmpeg" -hide_banner -buildconf)"
  local feature
  for feature in libx264 libvpx libopus; do
    if ! grep -q -- "--enable-${feature}" <<<"$buildconf"; then
      echo "error: [$label] ffmpeg lacks --enable-${feature}" >&2
      exit 1
    fi
  done
  local dylibs
  dylibs="$(otool -L "$fbuild/out/bin/ffmpeg")"
  local lib
  for lib in x264 vpx opus; do
    if grep -qi "lib${lib}" <<<"$dylibs"; then
      echo "error: [$label] ffmpeg dynamically links lib${lib}; static link failed" >&2
      grep -i "lib${lib}" <<<"$dylibs" >&2
      exit 1
    fi
  done

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
