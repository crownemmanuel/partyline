#!/usr/bin/env bash
# Copy the Android app into the desktop bundle so the host can serve it to phones.
#   scripts/fetch-apk.sh [path/to/app.apk]
# Default: the newest release APK from apps/android, else the debug APK.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/apps/desktop/src-tauri/resources/partyline.apk"
src="${1:-}"
if [[ -z "$src" ]]; then
  for c in "$root"/apps/android/app/build/outputs/apk/release/*.apk "$root"/apps/android/app/build/outputs/apk/debug/app-debug.apk; do
    [[ -f "$c" ]] && { src="$c"; break; }
  done
fi
[[ -n "$src" && -f "$src" ]] || { echo "no APK found; build it in apps/android (./gradlew assembleRelease) or pass a path" >&2; exit 1; }
cp "$src" "$out"
echo "bundled $(basename "$src") ($(du -h "$out" | cut -f1)) -> ${out#$root/}"
case "$src" in *debug*) echo "note: this is a DEBUG build (large, debug-signed); use a signed release APK for real shows" >&2 ;; esac
