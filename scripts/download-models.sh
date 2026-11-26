#!/usr/bin/env bash
# Downloads the local speech-to-text models into ./models (about 800 MB).
# Safe to re-run: models that are already there are skipped.
set -euo pipefail

BASE="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"
DIR="$(cd "$(dirname "$0")/.." && pwd)/models"
mkdir -p "$DIR"
cd "$DIR"

fetch_tar() {
  local name="$1"
  if [ -d "$name" ]; then echo "✓ $name (already downloaded)"; return; fi
  echo "↓ $name"
  curl -fL --progress-bar "$BASE/$name.tar.bz2" -o "$name.tar.bz2"
  tar xjf "$name.tar.bz2"
  rm "$name.tar.bz2"
}

# Parakeet TDT 0.6B v2 (NVIDIA), English, int8
fetch_tar sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8
# Streaming Zipformer, English
fetch_tar sherpa-onnx-streaming-zipformer-en-2023-06-26

if [ ! -f silero_vad.onnx ]; then
  echo "↓ silero_vad.onnx"
  curl -fL --progress-bar "$BASE/silero_vad.onnx" -o silero_vad.onnx
fi

echo "Models are ready in $DIR"
