#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

cd "$(dirname "${BASH_SOURCE[0]}")/.."
root="$PWD"
mode="${1:-debug}"
case "$mode" in
  debug) build_flags=(--debug) ;;
  release) build_flags=() ;;
  *) printf 'Usage: bash scripts/build-android.sh [debug|release]\n' >&2; exit 2 ;;
esac

: "${ANDROID_HOME:?Set ANDROID_HOME to the Android SDK directory}"
if [[ "$mode" == release ]]; then
  node scripts/check-android-signing.mjs
fi
export NDK_HOME="${NDK_HOME:-$ANDROID_HOME/ndk/28.2.13676358}"
export ANDROID_NDK_HOME="$NDK_HOME"
work="$root/.cache/android-build"
mkdir -p "$work/bin"
export PATH="$work/bin:$PATH"
export GOBIN="$work/bin"
for pair in "android-arm64 aarch64" "android-x64 x86_64"; do
  read -r runtime_target runtime_arch <<< "$pair"
  runtime_root="$root/src-tauri/resources/sub-store"
  if ! python3 scripts/validate-sub-store-resources.py "$runtime_root" "$runtime_arch" --platform android \
    || ! node scripts/sub-store/build-android-runtime.cjs --target "$runtime_target" --verify-elf "$runtime_root/$runtime_target/node"; then
    node scripts/sub-store/build-android-runtime.cjs --target "$runtime_target"
  fi
done
python3 scripts/prepare-android-geodata.py
mobile="v0.0.0-20261117202452-47699113848a"
go install "golang.org/x/mobile/cmd/gomobile@$mobile" "golang.org/x/mobile/cmd/gobind@$mobile"
core_work="$work/patched-core"
python3 scripts/prepare-android-core.py --output "$core_work"
(
  # Gomobile generates a module of its own: use the prepared workspace's
  # normal go.mod instead of a global -modfile that overrides that module.
  export GOFLAGS='' GOWORK=off
  cd "$core_work/core"
  go test -tags with_gvisor,cmfa ./mobile -count=1
  mihomo_version="$(go list -m -f '{{.Version}}' github.com/metacubex/mihomo)"
  gomobile bind -target=android/arm64,android/amd64 -androidapi 24 -tags with_gvisor,cmfa \
    -trimpath -ldflags="-s -w -X github.com/metacubex/mihomo/constant.Version=$mihomo_version" -o "$work/mihomo.aar" ./mobile
)

project="$root/src-tauri/gen/android"
if [[ ! -f "$project/app/build.gradle.kts" ]]; then
  npm run tauri -- android init --ci --skip-targets-install
fi
node scripts/configure-android.mjs "$project" "$work/mihomo.aar"
# Start APK assembly from clean outputs: incremental ZIP updates can retain large freed entries.
# Cargo targets and the core AAR remain cached outside the generated app build directory.
# Do not invoke Gradle yet: Cargo generates tauri.settings.gradle during Tauri's first build.
rm -rf "$project/app/build"
npm run tauri -- android build --ci --target aarch64 x86_64 --split-per-abi --apk ${build_flags[@]+"${build_flags[@]}"}
if [[ "$mode" == release ]]; then
  npm run tauri -- android build --ci --target aarch64 x86_64 --aab
fi

version="$(node -p 'require("./package.json").version')"
out="$work/dist/$mode"
mkdir -p "$out"
# Only this script's generated artifact directory is cleared; never retain an old version for publication.
find "$out" -maxdepth 1 -type f \( -name 'ppclash-android-*.apk' -o -name 'ppclash-android-*.aab' -o -name SHA256SUMS \) -delete
for target in arm64 x86_64; do
  abi="$target"
  [[ "$target" != arm64 ]] || abi=arm64-v8a
  apk="$project/app/build/outputs/apk/$target/$mode/app-$target-$mode.apk"
  unzip -Z1 "$apk" | awk -F/ -v abi="$abi" '
    $1 == "lib" && $2 != abi { bad = 1 }
    $1 == "lib" && $3 == "libppclash_lib.so" { rust = 1 }
    $1 == "lib" && $3 == "libgojni.so" { go = 1 }
    END { exit (bad || !rust || !go) }
  '
  cp "$apk" "$out/ppclash-android-$abi-v$version.apk"
done
if [[ "$mode" == release ]]; then
  aab="$project/app/build/outputs/bundle/universalRelease/app-universal-release.aab"
  for abi in arm64-v8a x86_64; do
    unzip -Z1 "$aab" | awk -F/ -v abi="$abi" '
      $1 == "base" && $2 == "lib" && $3 == abi && $4 == "libppclash_lib.so" { rust = 1 }
      $1 == "base" && $2 == "lib" && $3 == abi && $4 == "libgojni.so" { go = 1 }
      END { exit (!rust || !go) }
    '
  done
  cp "$aab" "$out/ppclash-android-v$version.aab"
fi
node scripts/validate-android.mjs "$out" "$version" "$mode"
(
  cd "$out"
  if command -v sha256sum >/dev/null; then sha256sum ppclash-android-* > SHA256SUMS;
  else shasum -a 256 ppclash-android-* > SHA256SUMS; fi
)
printf 'Android artifacts: %s\n' "$out"
