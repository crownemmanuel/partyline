#!/usr/bin/env bash
# Builds libdfjni.so (DeepFilterNet3 voice isolation, model embedded) into app/src/main/jniLibs.
# Needs: rustup with the Android targets, and the Android NDK (r27). The .so files are checked in,
# so a normal Gradle build does not need Rust; rerun this only when native/dfjni changes.
set -euo pipefail
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
NDK="${ANDROID_NDK_HOME:-$(ls -d "$SDK"/ndk/* | sort -V | tail -1)}"
HOST="$(ls "$NDK/toolchains/llvm/prebuilt" | head -1)"
BIN="$NDK/toolchains/llvm/prebuilt/$HOST/bin"
API=26
OUT=../app/src/main/jniLibs

build() { # rust target, clang prefix, android abi
  local target=$1 clang=$2 abi=$3
  local env_target; env_target=$(echo "$target" | tr 'a-z-' 'A-Z_')
  rustup target add "$target" >/dev/null
  export "CARGO_TARGET_${env_target}_LINKER=$BIN/${clang}${API}-clang"
  export "CC_${target//-/_}=$BIN/${clang}${API}-clang"
  export "AR_${target//-/_}=$BIN/llvm-ar"
  cargo build --manifest-path dfjni/Cargo.toml --release --target "$target"
  mkdir -p "$OUT/$abi"
  cp "dfjni/target/$target/release/libdfjni.so" "$OUT/$abi/"
}

build aarch64-linux-android   aarch64-linux-android     arm64-v8a
build armv7-linux-androideabi armv7a-linux-androideabi  armeabi-v7a
build x86_64-linux-android    x86_64-linux-android      x86_64
ls -la "$OUT"/*/libdfjni.so
