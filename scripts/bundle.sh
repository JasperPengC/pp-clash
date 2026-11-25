#!/usr/bin/env bash
# 打包 macOS .app
#
# 为什么不用 `tauri build`：它在非 TTY 环境（CI、脚本、某些终端）下会静默退出，
# 什么都不输出也不报错。这里用 cargo 直接编译再手工组装 bundle，行为可控。
set -euo pipefail

cd "$(dirname "$0")/.."
source scripts/macos-resource-gate.sh
RESOURCE_ZIP="${KERNEL_RESOURCE_ZIP:-src-tauri/resources/kernel.zip}"
case "${PPCLASH_COMPILE_ONLY:-0}" in
  0) validate_macos_bundle_resources "$RESOURCE_ZIP" ;;
  1) echo "▸ compile-only：仅编译，不组装或签名 .app，不生成发布包" ;;
  *) echo "PPCLASH_COMPILE_ONLY 只能为 0 或 1" >&2; exit 1 ;;
esac
VERSION="$(node -p "require('./package.json').version")"
export PATH="$HOME/.cargo/bin:$PATH"

# 图标产物（icon.icns / icon.png / tray 状态图）已提交在 src-tauri/icons 与
# src-tauri/resources/tray；不要在这里重新生成，避免旧 SVG 覆盖新猫头。
[ -f src-tauri/icons/icon.png ] || { echo "缺少 src-tauri/icons/icon.png" >&2; exit 1; }
[ -f src-tauri/icons/icon.icns ] || { echo "缺少 src-tauri/icons/icon.icns" >&2; exit 1; }
if [ "${PPCLASH_COMPILE_ONLY:-0}" = "0" ]; then
  SERVICE_ARCH="$(macos_resource_arch)"
  SERVICE_PY="$(command -v python || command -v python3)"
  "$SERVICE_PY" scripts/validate-sub-store-resources.py src-tauri/resources/sub-store "$SERVICE_ARCH"
fi

echo "▸ 构建前端"
npm run build

FINAL_APP="${APP_PATH:-src-tauri/target/release/bundle/macos/PP Clash.app}"
BIN="src-tauri/target/release/ppclash"

if [ "${PPCLASH_COMPILE_ONLY:-0}" = "1" ] && [ "${UNIVERSAL:-0}" = "1" ]; then
  for target in x86_64-apple-darwin aarch64-apple-darwin; do
    cargo build --locked --release --target "$target" --manifest-path src-tauri/Cargo.toml
  done
  echo "▸ 双架构编译检查完成（无 .app / DMG 产物）"
  exit 0
fi
RESOURCE_ARCH="$(macos_resource_arch)"
if [ "$RESOURCE_ARCH" = x86_64 ]; then
  MACOS_TARGET=x86_64-apple-darwin
else
  MACOS_TARGET=aarch64-apple-darwin
fi
echo "▸ 编译 Rust (release, $MACOS_TARGET)"
cargo build --locked --release --target "$MACOS_TARGET" --manifest-path src-tauri/Cargo.toml
BIN="src-tauri/target/$MACOS_TARGET/release/ppclash"
if [ "${PPCLASH_COMPILE_ONLY:-0}" = "1" ]; then
  echo "▸ 单架构编译检查完成（无 .app / DMG 产物）"
  exit 0
fi

mkdir -p "$(dirname "$FINAL_APP")"
BUNDLE_STAGE="$(mktemp -d "$(dirname "$FINAL_APP")/.ppclash-bundle.XXXXXX")"
trap 'rm -rf "$BUNDLE_STAGE"' EXIT
APP="$BUNDLE_STAGE/PP Clash.app"
echo "▸ 组装 $FINAL_APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/ppclash"

cp src-tauri/icons/icon.icns "$APP/Contents/Resources/icon.icns"
mkdir -p "$APP/Contents/Resources/resources"
cp "$RESOURCE_ZIP" "$APP/Contents/Resources/resources/kernel.zip"
validate_macos_bundle_resources "$APP/Contents/Resources/resources/kernel.zip"
cp -R src-tauri/resources/sub-store "$APP/Contents/Resources/sub-store"
"$SERVICE_PY" scripts/validate-sub-store-resources.py "$APP/Contents/Resources/sub-store" "$SERVICE_ARCH"

echo "▸ 写 Info.plist"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleExecutable</key><string>ppclash</string>
  <key>CFBundleIdentifier</key><string>com.ppclash.app</string>
  <key>CFBundleName</key><string>PP Clash</string>
  <key>CFBundleDisplayName</key><string>PP Clash</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>13.5</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

echo "▸ 签名（adhoc）"
codesign --force --deep --sign - "$APP"
rm -rf "$FINAL_APP"
mv "$APP" "$FINAL_APP"

echo
echo "✅ 完成：$FINAL_APP"
du -sh "$FINAL_APP"
