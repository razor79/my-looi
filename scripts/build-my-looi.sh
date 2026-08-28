#!/usr/bin/env bash
set -Eeuo pipefail

# Generic My LOOI Android archive build helper.
#
# This script may either live beside release .tgz files (recommended on a build
# machine) or be run from scripts/ inside an extracted My LOOI source tree.
# Normal mode carries safe generated Android/Gradle state forward between
# semantic versions. --fresh is the clean control path.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/../package.json" && -f "$SCRIPT_DIR/../app.json" ]]; then
  default_base="$(cd "$SCRIPT_DIR/../.." && pwd)"
else
  default_base="$SCRIPT_DIR"
fi
BASE_DIR="${MY_LOOI_RELEASE_DIR:-$default_base}"
ENV_BACKUP="$BASE_DIR/.looi-build.env"
SIGNING_ENV="${MY_LOOI_SIGNING_ENV:-$HOME/.config/my-looi/signing/release.env}"
FRESH=0
JOBS=""
ARCHIVE_ARG=""
SOURCE_SNAPSHOT=""

cleanup() {
  if [[ -n "$SOURCE_SNAPSHOT" && -d "$SOURCE_SNAPSHOT" ]]; then
    rm -rf "$SOURCE_SNAPSHOT"
  fi
}
trap cleanup EXIT

usage() {
  cat <<'USAGE'
Usage:
  ./build-my-looi.sh [--fresh] [--jobs N] [archive.tgz]

Default mode:
  - finds the newest my-looi-vMAJOR.MINOR.PATCH*.tgz when omitted;
  - verifies a matching .tgz.sha256 when present;
  - carries safe generated state from the previous version when possible;
  - always refreshes authoritative source files from the selected archive;
  - preserves ROOT /android, node_modules and useful generated build caches;
  - never excludes nested modules/*/android source directories;
  - loads ~/.config/my-looi/signing/release.env automatically when needed;
  - runs an incremental Expo prebuild and Gradle build-cache path;
  - copies the final versioned APK + SHA-256 beside the release archives.

Options:
  --fresh      Clean source extraction + expo prebuild --clean control build.
  --jobs N     Limit Gradle workers. Default: 1 on <=2 CPUs, otherwise 2.
  -h, --help   Show this help.

One-time signing setup:
  bash my-looi-v<version>/scripts/configure-release-signing.sh

Environment:
  MY_LOOI_RELEASE_DIR can override the archive/worktree directory.
  MY_LOOI_SIGNING_ENV can override the private signing env file.
  ANDROID_SDK_ROOT / ANDROID_HOME are honored by the project build script.
USAGE
}

while (($#)); do
  case "$1" in
    --fresh)
      FRESH=1
      ;;
    --jobs)
      shift
      if (($# == 0)) || [[ ! "$1" =~ ^[1-9][0-9]*$ ]]; then
        echo "ERROR: --jobs requires a positive integer." >&2
        exit 2
      fi
      JOBS="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "ERROR: Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "$ARCHIVE_ARG" ]]; then
        echo "ERROR: Only one archive may be specified." >&2
        exit 2
      fi
      ARCHIVE_ARG="$1"
      ;;
  esac
  shift
done

extract_version_from_name() {
  local name="$1"
  if [[ "$name" =~ ^(my-looi|super-looi)-v([0-9]+\.[0-9]+\.[0-9]+)([^/]*)\.tgz$ ]]; then
    printf '%s\n' "${BASH_REMATCH[2]}"
    return 0
  fi
  return 1
}

version_key() {
  local version="$1"
  local major minor patch extra
  IFS='.' read -r major minor patch extra <<< "$version"
  if [[ -n "${extra:-}" || ! "$major" =~ ^[0-9]+$ || ! "$minor" =~ ^[0-9]+$ || ! "$patch" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  printf '%010d%010d%010d\n' "$major" "$minor" "$patch"
}

archive_rank() {
  case "$(basename "$1")" in
    my-looi-v*) printf '2\n' ;;
    *)         printf '1\n' ;;
  esac
}

find_latest_archive() {
  local file name version key mtime rank
  local best_file="" best_key="" best_mtime=-1 best_rank=-1

  shopt -s nullglob
  for file in "$BASE_DIR"/my-looi-v*.tgz "$BASE_DIR"/super-looi-v*.tgz; do
    [[ -f "$file" ]] || continue
    name="$(basename "$file")"
    version="$(extract_version_from_name "$name")" || continue
    key="$(version_key "$version")" || continue
    mtime="$(stat -c '%Y' "$file")"
    rank="$(archive_rank "$file")"

    if [[ -z "$best_key" || "$key" > "$best_key" || \
          ( "$key" == "$best_key" && "$rank" -gt "$best_rank" ) || \
          ( "$key" == "$best_key" && "$rank" -eq "$best_rank" && "$mtime" -gt "$best_mtime" ) ]]; then
      best_file="$file"
      best_key="$key"
      best_mtime="$mtime"
      best_rank="$rank"
    fi
  done
  shopt -u nullglob

  [[ -n "$best_file" ]] || return 1
  printf '%s\n' "$best_file"
}

find_previous_dir() {
  local current_version="$1"
  local current_key dir name version key
  local best_dir="" best_key=""

  current_key="$(version_key "$current_version")" || return 1

  shopt -s nullglob
  for dir in "$BASE_DIR"/my-looi-v* "$BASE_DIR"/super-looi-v*; do
    [[ -d "$dir" ]] || continue
    name="$(basename "$dir")"
    if [[ "$name" =~ ^(my-looi|super-looi)-v([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
      version="${BASH_REMATCH[2]}"
      key="$(version_key "$version")" || continue
      if [[ "$key" < "$current_key" && ( -z "$best_key" || "$key" > "$best_key" ) ]]; then
        best_dir="$dir"
        best_key="$key"
      fi
    fi
  done
  shopt -u nullglob

  printf '%s\n' "$best_dir"
}

verify_archive_sha256() {
  local archive="$1"
  local checksum_file="${archive}.sha256"
  local expected actual

  if [[ ! -f "$checksum_file" ]]; then
    echo "==> No matching .sha256 file; archive checksum verification skipped"
    return 0
  fi

  expected="$(awk 'NF {print $1; exit}' "$checksum_file")"
  if [[ ! "$expected" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "ERROR: Invalid checksum file: $checksum_file" >&2
    return 1
  fi

  actual="$(sha256sum "$archive" | awk '{print $1}')"
  if [[ "${actual,,}" != "${expected,,}" ]]; then
    echo "ERROR: Source archive SHA-256 mismatch." >&2
    echo "Expected: $expected" >&2
    echo "Actual  : $actual" >&2
    return 1
  fi
  echo "==> Source archive SHA-256 OK: $actual"
}

free_kib() {
  df -Pk "$BASE_DIR" | awk 'NR==2 { print $4 }'
}

format_gib() {
  local kib="$1"
  LC_ALL=C awk -v kib="$kib" 'BEGIN { printf "%.1f", kib / 1024 / 1024 }'
}

free_gib() {
  format_gib "$(free_kib)"
}

copy_tree_reflink_auto() {
  local from="$1" to="$2"
  mkdir -p "$to"
  if cp -a --reflink=auto "$from/." "$to/" 2>/dev/null; then
    return 0
  fi
  rm -rf "$to"
  mkdir -p "$to"
  cp -a "$from/." "$to/"
}

make_source_snapshot() {
  local archive="$1"
  SOURCE_SNAPSHOT="$(mktemp -d "$BASE_DIR/.my-looi-source-sync.XXXXXX")"
  mkdir -p "$SOURCE_SNAPSHOT/source"
  tar -xzf "$archive" -C "$SOURCE_SNAPSHOT/source" --strip-components=1
}

prune_removed_source_modules() {
  local snapshot="$1" target="$2" target_module module_name

  # Native module build caches are preserved only while the module itself still
  # exists in the authoritative source. rsync --delete protects excluded
  # modules/*/android/build and .cxx paths, which otherwise leaves a deleted
  # module directory behind and can make source regressions/build discovery see
  # stale code from the previous release.
  [[ -d "$target/modules" ]] || return 0
  shopt -s nullglob
  for target_module in "$target"/modules/*; do
    [[ -d "$target_module" ]] || continue
    module_name="$(basename "$target_module")"
    if [[ ! -e "$snapshot/modules/$module_name" ]]; then
      echo "==> Removing retired source module: modules/$module_name"
      rm -rf -- "$target_module"
    fi
  done
  shopt -u nullglob
}

sync_authoritative_source() {
  local snapshot="$1" target="$2"
  if ! command -v rsync >/dev/null 2>&1; then
    echo "ERROR: rsync is required for safe incremental source refresh." >&2
    echo "Install rsync or rerun with --fresh." >&2
    exit 1
  fi

  prune_removed_source_modules "$snapshot" "$target"

  # Leading '/' anchors these exclusions to the project root. In particular,
  # /android/ is generated and preserved while modules/*/android source is NOT
  # excluded. This avoids the historical broad android/ exclusion bug.
  rsync -a --checksum --delete \
    --exclude '/android/' \
    --exclude '/ios/' \
    --exclude '/node_modules/' \
    --exclude '/.expo/' \
    --exclude '/.build-assets/' \
    --exclude '/output/' \
    --exclude '/.env' \
    --exclude '/modules/*/android/build/' \
    --exclude '/modules/*/android/.cxx/' \
    "$snapshot/" "$target/"
}

if [[ -z "$JOBS" ]]; then
  CPU_COUNT="$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 1)"
  if (( CPU_COUNT <= 2 )); then
    JOBS=1
  else
    JOBS=2
  fi
else
  CPU_COUNT="$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo '?')"
fi

mkdir -p "$BASE_DIR"
BASE_DIR="$(cd "$BASE_DIR" && pwd)"

if [[ -n "$ARCHIVE_ARG" ]]; then
  if [[ "$ARCHIVE_ARG" = /* ]]; then
    ARCHIVE="$ARCHIVE_ARG"
  else
    ARCHIVE="$PWD/$ARCHIVE_ARG"
  fi
  ARCHIVE="$(readlink -f "$ARCHIVE")"
else
  if ! ARCHIVE="$(find_latest_archive)"; then
    echo "ERROR: No my-looi-vMAJOR.MINOR.PATCH*.tgz archive found in:" >&2
    echo "       $BASE_DIR" >&2
    exit 1
  fi
fi

if [[ ! -f "$ARCHIVE" ]]; then
  echo "ERROR: Archive not found: $ARCHIVE" >&2
  exit 1
fi

ARCHIVE_NAME="$(basename "$ARCHIVE")"
if ! VERSION="$(extract_version_from_name "$ARCHIVE_NAME")"; then
  echo "ERROR: Unsupported archive name: $ARCHIVE_NAME" >&2
  exit 1
fi

TARGET_DIR="$BASE_DIR/my-looi-v$VERSION"
PREVIOUS_DIR="$(find_previous_dir "$VERSION")"
LOG_FILE="$BASE_DIR/build-my-looi-v$VERSION-$(date '+%Y%m%d-%H%M%S').log"
TOP_APK="$BASE_DIR/my-looi-v$VERSION.apk"
TOP_SHA="$TOP_APK.sha256"

printf '%s\n' "============================================================"
printf '%s\n' " My LOOI Android build"
printf '%s\n' "============================================================"
echo "Base directory : $BASE_DIR"
echo "Archive        : $ARCHIVE_NAME"
echo "Version        : v$VERSION"
echo "Target         : $TARGET_DIR"
echo "Previous       : ${PREVIOUS_DIR:-none}"
echo "Mode           : $([[ "$FRESH" == 1 ]] && echo fresh || echo incremental)"
echo "CPUs visible   : $CPU_COUNT"
echo "Gradle workers : $JOBS"
echo "Signing config : $SIGNING_ENV"
echo "Disk free      : $(free_gib) GiB"
echo

verify_archive_sha256 "$ARCHIVE"
make_source_snapshot "$ARCHIVE"

# Preserve the optional development .env separately from source archives.
if [[ -f "$TARGET_DIR/.env" ]]; then
  cp -f "$TARGET_DIR/.env" "$ENV_BACKUP"
  chmod 600 "$ENV_BACKUP"
elif [[ ! -f "$ENV_BACKUP" && -n "$PREVIOUS_DIR" && -f "$PREVIOUS_DIR/.env" ]]; then
  cp -f "$PREVIOUS_DIR/.env" "$ENV_BACKUP"
  chmod 600 "$ENV_BACKUP"
fi

if (( FRESH )); then
  if [[ -d "$TARGET_DIR" ]]; then
    echo "==> Fresh mode: removing previous v$VERSION worktree"
    rm -rf "$TARGET_DIR"
  fi
  mkdir -p "$TARGET_DIR"
  rsync -a --delete "$SOURCE_SNAPSHOT/source/" "$TARGET_DIR/"
  export MY_LOOI_INCREMENTAL_BUILD=0
else
  if [[ ! -d "$TARGET_DIR" ]]; then
    if [[ -n "$PREVIOUS_DIR" && -d "$PREVIOUS_DIR" ]]; then
      echo "==> Seeding v$VERSION from $(basename "$PREVIOUS_DIR") generated state"
      copy_tree_reflink_auto "$PREVIOUS_DIR" "$TARGET_DIR"
    else
      echo "==> No previous worktree; starting v$VERSION from source"
      mkdir -p "$TARGET_DIR"
    fi
  else
    echo "==> Reusing existing v$VERSION worktree"
  fi
  echo "==> Refreshing authoritative source while preserving generated build state"
  sync_authoritative_source "$SOURCE_SNAPSHOT/source" "$TARGET_DIR"
  export MY_LOOI_INCREMENTAL_BUILD=1
fi

if [[ ! -f "$TARGET_DIR/.env" && -f "$ENV_BACKUP" ]]; then
  echo "==> Restoring optional .env from $ENV_BACKUP"
  cp -f "$ENV_BACKUP" "$TARGET_DIR/.env"
  chmod 600 "$TARGET_DIR/.env"
fi
if [[ -f "$TARGET_DIR/.env" ]]; then
  cp -f "$TARGET_DIR/.env" "$ENV_BACKUP"
  chmod 600 "$ENV_BACKUP"
fi

PROJECT_BUILD="$TARGET_DIR/scripts/build-android-apk.sh"
if [[ ! -f "$PROJECT_BUILD" ]]; then
  echo "ERROR: Project Android build script not found: $PROJECT_BUILD" >&2
  exit 1
fi
chmod +x "$PROJECT_BUILD"

# Fail before the expensive build if neither persistent nor current-shell
# signing credentials are available. The project script performs final checks.
signing_ready=1
for var in MY_LOOI_RELEASE_KEYSTORE MY_LOOI_RELEASE_STORE_PASSWORD MY_LOOI_RELEASE_KEY_ALIAS MY_LOOI_RELEASE_KEY_PASSWORD; do
  if [[ -z "${!var:-}" ]]; then
    signing_ready=0
    break
  fi
done
if (( ! signing_ready )) && [[ ! -f "$SIGNING_ENV" ]]; then
  echo "ERROR: Release signing is not configured for automatic builds." >&2
  echo "Run this once:" >&2
  echo "  bash '$TARGET_DIR/scripts/configure-release-signing.sh'" >&2
  exit 1
fi

FREE_KIB="$(free_kib)"
echo "==> Disk free before build: $(format_gib "$FREE_KIB") GiB"
if (( FREE_KIB < 4 * 1024 * 1024 )); then
  echo "ERROR: Less than 4 GiB free; build aborted." >&2
  exit 1
elif (( FREE_KIB < 8 * 1024 * 1024 )); then
  echo "WARNING: Less than 8 GiB free; Android build may run out of space." >&2
fi

export GRADLE_OPTS="${GRADLE_OPTS:-} -Dorg.gradle.workers.max=$JOBS -Dorg.gradle.parallel=false"

echo
echo "==> Starting Android build"
echo "==> Log: $LOG_FILE"
echo

cd "$TARGET_DIR"
set +e
if command -v /usr/bin/time >/dev/null 2>&1; then
  { /usr/bin/time -v bash scripts/build-android-apk.sh; } 2>&1 | tee "$LOG_FILE"
else
  { bash scripts/build-android-apk.sh; } 2>&1 | tee "$LOG_FILE"
fi
BUILD_RC=${PIPESTATUS[0]}
set -e

if (( BUILD_RC != 0 )); then
  echo
  echo "============================================================"
  echo " BUILD FAILED (exit $BUILD_RC)"
  echo "============================================================"
  echo "Directory kept : $TARGET_DIR"
  echo "Log            : $LOG_FILE"
  echo "Disk free      : $(free_gib) GiB"
  exit "$BUILD_RC"
fi

APK_SOURCE="$TARGET_DIR/output/android/my-looi-v$VERSION.apk"
if [[ ! -f "$APK_SOURCE" ]]; then
  APK_SOURCE="$(find "$TARGET_DIR/output/android" -maxdepth 1 -type f -name '*.apk' -print -quit 2>/dev/null || true)"
fi
if [[ -z "$APK_SOURCE" || ! -f "$APK_SOURCE" ]]; then
  echo "ERROR: Build exited 0, but no APK was found under output/android." >&2
  exit 1
fi

cp -f "$APK_SOURCE" "$TOP_APK"
sha256sum "$TOP_APK" > "$TOP_SHA"
CERT_SHA256="$(grep -F 'Signer #1 certificate SHA-256 digest:' "$LOG_FILE" | tail -1 || true)"
CERT_SHA1="$(grep -F 'Signer #1 certificate SHA-1 digest:' "$LOG_FILE" | tail -1 || true)"

echo
echo "============================================================"
echo " BUILD SUCCESSFUL"
echo "============================================================"
echo "Version        : v$VERSION"
echo "APK            : $TOP_APK"
echo "APK SHA-256    : $(awk '{print $1}' "$TOP_SHA")"
echo "Source         : $TARGET_DIR"
echo "Build log      : $LOG_FILE"
if [[ -f "$ENV_BACKUP" ]]; then
  echo "Saved .env     : $ENV_BACKUP"
fi
echo "Signing env    : $SIGNING_ENV"
echo "Disk free      : $(free_gib) GiB"
[[ -n "$CERT_SHA256" ]] && echo "$CERT_SHA256"
[[ -n "$CERT_SHA1" ]] && echo "$CERT_SHA1"
echo
echo "Next normal build:"
echo "  ./build-my-looi.sh"
echo "Clean control build:"
echo "  ./build-my-looi.sh --fresh"
