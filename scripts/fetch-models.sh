#!/usr/bin/env bash
#
# fetch-models.sh — download the ONNX detector models for subject-aware
# auto-reframe (v2 Tier 2) into src-tauri/models. They're platform-independent
# (pure-Rust `tract` runs them, no native ONNX Runtime), so one fetch serves
# every target. Gitignored; bundled as Tauri resources at build time.
#
# Models (both raw-output — ClipSmith decodes boxes + runs NMS in Rust, which
# keeps the ONNX graphs op-simple so `tract` loads them cleanly):
#   - Ultraface RFB-320 (face)   — MIT           (~1.2MB)
#   - NanoDet-Plus-m 416 (person)— Apache-2.0    (~4.8MB, COCO; person = class 0)
#
# Both licenses are GPL-3.0-compatible.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MODELS_DIR="$REPO_ROOT/src-tauri/models"

mkdir -p "$MODELS_DIR"

# name|url|min-bytes (a size floor guards against a truncated / HTML error page)
MODELS=(
  "ultraface-320.onnx|https://github.com/onnx/models/raw/main/validated/vision/body_analysis/ultraface/models/version-RFB-320.onnx|1000000"
  "nanodet-plus-m-416.onnx|https://github.com/RangiLyu/nanodet/releases/download/v1.0.0-alpha-1/nanodet-plus-m_416.onnx|4000000"
)

for entry in "${MODELS[@]}"; do
  IFS='|' read -r name url min <<< "$entry"
  dest="$MODELS_DIR/$name"
  echo "Downloading $name..."
  curl -fL --retry 3 -o "$dest" "$url"
  size="$(wc -c < "$dest")"
  if [ "$size" -lt "$min" ]; then
    echo "error: $name is only $size bytes (< $min); download looks wrong" >&2
    rm -f "$dest"
    exit 1
  fi
  echo "placed $name ($(du -h "$dest" | cut -f1))"
done

echo "Done. Models in $MODELS_DIR"
