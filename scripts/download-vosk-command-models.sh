#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/super-looi/vosk-command-models"
stage_root="$repo_dir/.build-assets/vosk"
mkdir -p "$cache_root/zips" "$cache_root/extracted" "$stage_root"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }
}
need_cmd curl
need_cmd unzip

fetch_model() {
  local language="$1"
  local source_name="$2"
  local target_name="$3"
  local url="$4"
  local zip="$cache_root/zips/${source_name}.zip"
  local extracted="$cache_root/extracted/$source_name"
  local stage="$stage_root/$target_name"

  if [[ ! -f "$zip" ]]; then
    echo "Downloading Vosk $language command model: $source_name"
    curl -fL --retry 4 --retry-delay 2 --connect-timeout 20 -o "$zip.part" "$url"
    mv "$zip.part" "$zip"
  fi

  if [[ ! -d "$extracted" ]] || [[ -z "$(find "$extracted" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    echo "Extracting Vosk $language command model..."
    rm -rf "$cache_root/extracted/.tmp-$source_name" "$extracted"
    mkdir -p "$cache_root/extracted/.tmp-$source_name"
    unzip -q "$zip" -d "$cache_root/extracted/.tmp-$source_name"
    if [[ ! -d "$cache_root/extracted/.tmp-$source_name/$source_name" ]]; then
      echo "Unexpected Vosk archive layout for $source_name" >&2
      exit 1
    fi
    mv "$cache_root/extracted/.tmp-$source_name/$source_name" "$extracted"
    rm -rf "$cache_root/extracted/.tmp-$source_name"
  fi

  rm -rf "$stage"
  # Stage by copy so Expo's Android asset copy is deterministic even when the
  # cache and project live on different filesystems.
  cp -a "$extracted" "$stage"
  echo "Prepared $language: $stage"
}

# Strongest practical grammar-capable choices from the official Vosk model list.
# RU has no larger official lookahead/lgraph model, so the 45 MB small model is
# chosen for runtime grammar support rather than storage savings.
fetch_model "RU" "vosk-model-small-ru-0.22" "vosk-command-ru" \
  "https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip"
fetch_model "UA" "vosk-model-uk-v3-lgraph" "vosk-command-uk" \
  "https://alphacephei.com/vosk/models/vosk-model-uk-v3-lgraph.zip"
fetch_model "EN" "vosk-model-en-us-0.22-lgraph" "vosk-command-en" \
  "https://alphacephei.com/vosk/models/vosk-model-en-us-0.22-lgraph.zip"

echo "Vosk command models ready."
