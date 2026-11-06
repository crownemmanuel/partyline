#!/usr/bin/env bash
# Fetch the pinned livekit-server binary as a Tauri sidecar:
#   apps/desktop/src-tauri/binaries/livekit-server-<target-triple>[.exe]
# Version: apps/desktop/livekit.version. Linux/Windows come from the GitHub release and are
# checked against its checksums.txt. LiveKit publishes no macOS release asset, so on macOS
# we take the Homebrew bottle of the same version (brew verifies the bottle's sha256) and
# record its sha256 next to the binary.
#
# Usage: scripts/fetch-livekit.sh [target-triple ...]   (default: this machine's triple)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(tr -d ' \n' < "$ROOT/apps/desktop/livekit.version")"
V="${VERSION#v}"
OUT="$ROOT/apps/desktop/src-tauri/binaries"
mkdir -p "$OUT"
host_triple() { rustc -vV 2>/dev/null | sed -n 's/^host: //p'; }
TRIPLES=("$@"); [ ${#TRIPLES[@]} -eq 0 ] && TRIPLES=("$(host_triple)")
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
BASE="https://github.com/livekit/livekit/releases/download/$VERSION"

# shasum on macOS, sha256sum on Linux and Git Bash (Windows CI)
sha() { if command -v shasum >/dev/null; then shasum -a 256 "$1"; else sha256sum "$1"; fi | cut -d' ' -f1; }

for T in "${TRIPLES[@]}"; do
  case "$T" in
    x86_64-unknown-linux-gnu)  ASSET="livekit_${V}_linux_amd64.tar.gz" ;;
    aarch64-unknown-linux-gnu) ASSET="livekit_${V}_linux_arm64.tar.gz" ;;
    x86_64-pc-windows-msvc)    ASSET="livekit_${V}_windows_amd64.zip" ;;
    aarch64-apple-darwin|x86_64-apple-darwin) ASSET="" ;;
    *) echo "unsupported target $T" >&2; exit 1 ;;
  esac
  EXT=""; [[ "$T" == *windows* ]] && EXT=".exe"
  DEST="$OUT/livekit-server-$T$EXT"
  if [ -z "$ASSET" ]; then
    if [ "$T" != "$(host_triple)" ]; then echo "macOS $T: run this on a Mac of that arch (brew bottle)" >&2; exit 1; fi
    command -v brew >/dev/null || { echo "Homebrew required on macOS" >&2; exit 1; }
    if ! brew list --versions livekit | grep -q " $V"; then brew install livekit || brew upgrade livekit; fi
    BIN="$(brew --prefix livekit)/bin/livekit-server"
    "$BIN" --version | grep -q "$V" || { echo "brew livekit is not $V: $("$BIN" --version)" >&2; exit 1; }
    cp -f "$BIN" "$DEST"
  else
    curl -fsSL -o "$TMP/$ASSET" "$BASE/$ASSET"
    curl -fsSL -o "$TMP/checksums.txt" "$BASE/checksums.txt"
    WANT="$(grep " $ASSET\$" "$TMP/checksums.txt" | cut -d' ' -f1)"
    GOT="$(sha "$TMP/$ASSET")"
    [ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || { echo "sha256 mismatch for $ASSET: want $WANT got $GOT" >&2; exit 1; }
    mkdir -p "$TMP/x-$T"
    if [[ "$ASSET" == *.zip ]]; then unzip -q -o "$TMP/$ASSET" -d "$TMP/x-$T"; else tar -xzf "$TMP/$ASSET" -C "$TMP/x-$T"; fi
    cp -f "$TMP/x-$T/livekit-server$EXT" "$DEST"
  fi
  chmod +x "$DEST"
  sha "$DEST" > "$DEST.sha256"
  echo "ok $T -> $(basename "$DEST") ($(cut -c1-16 < "$DEST.sha256")…)"
done
