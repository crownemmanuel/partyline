#!/bin/bash
# Builds libDF (DeepFilterNet's C API) for iPhone + Apple-silicon Simulator, bundles the
# DeepFilterNet3 model, and switches the Xcode project to link it. Needs rustup and xcodegen.
set -euo pipefail
cd "$(dirname "$0")/.."

DFN_REPO=https://github.com/Rikorose/DeepFilterNet.git
DFN_REV=${DFN_REV:-7b14b895fe7fc42cab72b4a4c1e49c982bd6404b}
WORK=build/deepfilternet
TARGETS=(aarch64-apple-ios aarch64-apple-ios-sim)

if [ ! -d "$WORK/.git" ]; then
  mkdir -p "$WORK"
  git -C "$WORK" init -q
  git -C "$WORK" remote add origin "$DFN_REPO"
fi
git -C "$WORK" fetch -q --depth 1 origin "$DFN_REV"
git -C "$WORK" checkout -q FETCH_HEAD

rustup target add "${TARGETS[@]}"
export IPHONEOS_DEPLOYMENT_TARGET=16.0
for t in "${TARGETS[@]}"; do
  cargo build --manifest-path "$WORK/Cargo.toml" -p deep_filter --lib --release \
    --no-default-features --features capi --target "$t"
done

rm -rf Vendor/DeepFilter.xcframework
xcodebuild -create-xcframework \
  -library "$WORK/target/aarch64-apple-ios/release/libdf.a" -headers Vendor/DeepFilterC \
  -library "$WORK/target/aarch64-apple-ios-sim/release/libdf.a" -headers Vendor/DeepFilterC \
  -output Vendor/DeepFilter.xcframework

cp "$WORK/models/DeepFilterNet3_onnx.tar.gz" PartyLine/Resources/

cat > libdf.yml <<'YML'
# Written by scripts/build-libdf.sh: link DeepFilterNet (libDF) for on-device voice isolation.
targets:
  PartyLine:
    dependencies:
      - framework: Vendor/DeepFilter.xcframework
        embed: false
YML
xcodegen generate
echo "libDF ready: Voice isolation now uses DeepFilterNet3."
