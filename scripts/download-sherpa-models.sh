#!/bin/bash
# Download the RU/UA/EN app-side sherpa-onnx models without committing large assets.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MODEL_ROOT="${MODEL_ROOT:-$ROOT_DIR/app-models/sherpa-onnx}"
ASR_DIR="$MODEL_ROOT/asr/whisper-tiny-multilingual-int8-v1"
KWS_DIR="$MODEL_ROOT/kws/looi-multilingual-v2"
SPEAKER_DIR="$MODEL_ROOT/speaker-id/looi"
TMP_DIR="$MODEL_ROOT/.tmp-v2"

cleanup() {
  rm -rf -- "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$ASR_DIR" "$KWS_DIR" "$SPEAKER_DIR" "$TMP_DIR"

require_file() {
  local path="$1"
  if [ ! -s "$path" ]; then
    echo "Required model file is missing or empty: $path" >&2
    exit 1
  fi
}

download_url() {
  local url="$1"
  local output="$2"
  if [ -s "$output" ]; then
    return
  fi
  curl -L --fail --retry 3 --retry-delay 2 "$url" -o "$output"
}

copy_from_tree() {
  local root="$1"
  local filename="$2"
  local destination="$3"
  local source
  source="$(find "$root" -type f -name "$filename" -print -quit)"
  if [ -z "$source" ]; then
    echo "Archive does not contain $filename" >&2
    exit 1
  fi
  cp "$source" "$destination"
}

echo "Downloading Whisper Tiny Multilingual..."
ASR_ARCHIVE="$TMP_DIR/sherpa-onnx-whisper-tiny.tar.bz2"
download_url \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.tar.bz2" \
  "$ASR_ARCHIVE"
mkdir -p "$TMP_DIR/whisper"
tar -xjf "$ASR_ARCHIVE" -C "$TMP_DIR/whisper"
copy_from_tree "$TMP_DIR/whisper" "tiny-encoder.int8.onnx" "$ASR_DIR/tiny-encoder.int8.onnx"
copy_from_tree "$TMP_DIR/whisper" "tiny-decoder.int8.onnx" "$ASR_DIR/tiny-decoder.int8.onnx"
copy_from_tree "$TMP_DIR/whisper" "tiny-tokens.txt" "$ASR_DIR/tiny-tokens.txt"

echo "Downloading the LOOI/Louie keyword model..."
KWS_ARCHIVE="$TMP_DIR/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2"
download_url \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2" \
  "$KWS_ARCHIVE"
mkdir -p "$TMP_DIR/kws"
tar -xjf "$KWS_ARCHIVE" -C "$TMP_DIR/kws"
copy_from_tree "$TMP_DIR/kws" "encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx" \
  "$KWS_DIR/encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx"
copy_from_tree "$TMP_DIR/kws" "decoder-epoch-13-avg-2-chunk-16-left-64.onnx" \
  "$KWS_DIR/decoder-epoch-13-avg-2-chunk-16-left-64.onnx"
copy_from_tree "$TMP_DIR/kws" "joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx" \
  "$KWS_DIR/joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx"
copy_from_tree "$TMP_DIR/kws" "tokens.txt" "$KWS_DIR/tokens.txt"
KEYWORDS_TMP="$KWS_DIR/keywords.txt.new"
printf '%s\n' \
  'L UW0 IY1 :2.4 #0.20 @LOOI' \
  'L UW0 Y IY1 :2.2 #0.20 @LOOI_PALATALIZED' \
  'S T AA1 P :4.5 #0.08 @STOP' \
  'S T AO1 P :4.5 #0.08 @STOP' \
  'S T AH1 P :4.3 #0.09 @STOP' \
  'S T EH1 P :4.0 #0.10 @STOP' \
  'S T OY1 :3.8 #0.10 @STOP' > "$KEYWORDS_TMP"
mv -f "$KEYWORDS_TMP" "$KWS_DIR/keywords.txt"

echo "Downloading the speaker ID model..."
download_url \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx" \
  "$SPEAKER_DIR/model.onnx"

require_file "$ASR_DIR/tiny-encoder.int8.onnx"
require_file "$ASR_DIR/tiny-decoder.int8.onnx"
require_file "$ASR_DIR/tiny-tokens.txt"
require_file "$KWS_DIR/encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx"
require_file "$KWS_DIR/decoder-epoch-13-avg-2-chunk-16-left-64.onnx"
require_file "$KWS_DIR/joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx"
require_file "$KWS_DIR/tokens.txt"
require_file "$KWS_DIR/keywords.txt"
require_file "$SPEAKER_DIR/model.onnx"

echo "Models downloaded under: $MODEL_ROOT"
echo "Whisper will auto-detect Russian, Ukrainian, and English."
