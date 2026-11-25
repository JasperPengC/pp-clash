#!/usr/bin/env bash
# 跨平台 CI 入口。
# GitHub Actions 负责 checkout 和工具链，构建与检查逻辑统一放在这里。
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT="$PWD"
KERNEL_ZIP="$ROOT/src-tauri/resources/kernel.zip"

log() { printf '\n▸ %s\n' "$*"; }

ensure_kernel_placeholder() {
  [ -f "$KERNEL_ZIP" ] && return 0
  log "生成 kernel.zip 占位文件（仅用于 CI 编译/测试，不是发布包）"
  mkdir -p "$(dirname "$KERNEL_ZIP")"
  local py
  py="$(command -v python3 || command -v python || true)"
  if [ -z "$py" ]; then
    echo "需要 python3 生成 kernel.zip 占位文件" >&2
    return 1
  fi
  "$py" - "$KERNEL_ZIP" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("version.txt", "placeholder\n")
PY
}

install() {
  log "安装前端依赖"
  npm ci
}

prepare_service_engine() {
  log "校验固定版本的 Sub-Store 构建工具链并重建引擎"
  node scripts/check-version.mjs
  scan
  npm ci --ignore-scripts --prefix scripts/sub-store/toolchain
  node scripts/sub-store/build.cjs
}

check_workflows() {
  log "GitHub Actions 工作流校验"
  if [ -n "${ACTIONLINT:-}" ]; then
    "$ACTIONLINT" -shellcheck='' .github/workflows/*.yml
  else
    go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 -shellcheck='' .github/workflows/*.yml
  fi
}

preflight() {
  node scripts/check-version.mjs
  scan
  check_workflows
  check_resources
}

build_web() {
  log "前端生产构建"
  npm run build
}

check_web() {
  log "平台图标一致性检查"
  npm run check:icons
  log "TypeScript 类型检查"
  npx tsc --noEmit
  log "前端单元测试"
  npx vitest run
  log "前端生产构建"
  npm run build
}

check_rust() {
  ensure_kernel_placeholder
  if [ ! -d dist ]; then
    log "前端 dist 不存在，先构建"
    npm run build
  fi
  log "Rust 测试"
  cargo test --locked --manifest-path src-tauri/Cargo.toml -- --skip kernel::tests::reclaim_kills_user_listener
}

check_resources() {
  log "资源门禁离线 fixture"
  local py
  py="${PYTHON:-$(command -v python || command -v python3)}"
  "$py" -m unittest discover -s scripts/tests -v
  if command -v pwsh >/dev/null 2>&1; then
    pwsh -NoProfile -NonInteractive -File scripts/tests/test-windows-scripts.ps1
  elif [ "${OS:-}" = "Windows_NT" ]; then
    powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/tests/test-windows-scripts.ps1
  else
    log "当前环境无 PowerShell，Windows 脚本行为测试由 Windows CI 执行"
  fi
}

validate_release_resources() {
  local os="$1"
  local digest="$2"
  local arch="${3:-x86_64}"
  local py
  py="${PYTHON:-$(command -v python || command -v python3)}"
  [ -n "$digest" ] || { echo "必须单独配置受信任的资源 ZIP SHA-256" >&2; return 1; }
  "$py" scripts/validate-resources.py "$KERNEL_ZIP" "$os" "$arch" --sha256 "$digest"
}

validate_release_service() {
  local py
  py="${PYTHON:-$(command -v python || command -v python3)}"
  "$py" scripts/validate-sub-store-resources.py src-tauri/resources/sub-store "$2" --platform "$1"
}

check() {
  check_web
  check_rust
  check_resources
  scan
}

build_macos() {
  install
  ensure_kernel_placeholder
  log "macOS Universal 应用壳编译检查（内核资源未通过双架构发布验收，禁止作为发布包）"
  PPCLASH_COMPILE_ONLY=1 UNIVERSAL=1 ./scripts/bundle.sh
}

release_target() {
  # 单一映射同时用于资源门禁、Rust target 和安装包命名。
  case "$1:$2" in
    macos:x86_64-apple-darwin) RESOURCE_ARCH=x86_64; PACKAGE_ARCH=x86_64 ;;
    macos:aarch64-apple-darwin) RESOURCE_ARCH=aarch64; PACKAGE_ARCH=arm64 ;;
    windows:x86_64-pc-windows-msvc|windows:x86_64-pc-windows-gnu) RESOURCE_ARCH=x86_64; PACKAGE_ARCH=amd64 ;;
    windows:aarch64-pc-windows-msvc) RESOURCE_ARCH=aarch64; PACKAGE_ARCH=arm64 ;;
    linux:x86_64-unknown-linux-gnu) RESOURCE_ARCH=x86_64; PACKAGE_ARCH=amd64 ;;
    linux:aarch64-unknown-linux-gnu) RESOURCE_ARCH=aarch64; PACKAGE_ARCH=arm64 ;;
    *) echo "不支持的发布平台或目标：$1/$2" >&2; return 1 ;;
  esac
}

build_macos_release() {
  [ "${PPCLASH_COMPILE_ONLY:-0}" = "0" ] || { echo "compile-only 模式禁止正式发布" >&2; return 1; }
  local target="${MACOS_TARGET:-${RELEASE_TARGET:-x86_64-apple-darwin}}"
  release_target macos "$target"
  validate_release_resources macos "${KERNEL_ZIP_SHA256:-}" "$RESOURCE_ARCH"
  install
  log "macOS $RESOURCE_ARCH App（内置同架构内核）"
  MACOS_TARGET="$target" UNIVERSAL=0 ./scripts/bundle.sh
  MACOS_TARGET="$target" UNIVERSAL=0 ./scripts/build-dmg.sh
}

build_windows() {
  install
  ensure_kernel_placeholder
  log "Windows NSIS 编译检查（非发布包）"
  npm run tauri -- build --no-bundle --target "${RELEASE_TARGET:-x86_64-pc-windows-msvc}"
}

normalize_installer() {
  local dir="$1" ext="$2" dest="$3" candidate="" file count=0
  while IFS= read -r file; do
    [ "$file" = "$dest" ] && continue
    candidate="$file"
    count=$((count + 1))
  done < <(find "$dir" -maxdepth 1 -type f -name "*.$ext" -print)
  if [ "$count" -gt 1 ]; then
    echo "安装包候选不唯一，请清理旧构建后重试：$dir" >&2
    return 1
  fi
  if [ "$count" = 1 ]; then
    [ -s "$candidate" ] || { echo "安装包为空：$candidate" >&2; return 1; }
    mv "$candidate" "$dest"
  else
    echo "本次构建没有生成新的安装包：$dir" >&2
    return 1
  fi
  [ -f "$dest" ] && [ -s "$dest" ] || { echo "找不到非空安装包：$dest" >&2; return 1; }
}

normalize_windows_installer() {
  local target="${RELEASE_TARGET:-x86_64-pc-windows-msvc}"
  release_target windows "$target"
  local version dir dest
  version="$(node -p "require('./package.json').version")"
  dir="src-tauri/target/$target/release/bundle/nsis"
  dest="$dir/PP_Clash-${version}-windows-${PACKAGE_ARCH}-setup.exe"
  normalize_installer "$dir" exe "$dest"
}

build_windows_release() {
  local target="${RELEASE_TARGET:-x86_64-pc-windows-msvc}"
  release_target windows "$target"
  validate_release_resources windows "${KERNEL_ZIP_SHA256:-${KERNEL_ZIP_SHA256_WINDOWS:-}}" "$RESOURCE_ARCH"
  validate_release_service windows "$RESOURCE_ARCH"
  install
  log "Windows $RESOURCE_ARCH NSIS（内置同架构内核）"
  npm run tauri -- build --target "$target" --bundles nsis
  RELEASE_TARGET="$target" normalize_windows_installer
}

build_linux_release() {
  local target="${RELEASE_TARGET:-x86_64-unknown-linux-gnu}"
  release_target linux "$target"
  validate_release_resources linux "${KERNEL_ZIP_SHA256:-}" "$RESOURCE_ARCH"
  validate_release_service linux "$RESOURCE_ARCH"
  install
  log "Linux $RESOURCE_ARCH（deb / rpm / AppImage，内置同架构内核）"
  # linuxdeploy 会 strip 并改写 AppDir 中所有 ELF，包括已锁定摘要的 Node。
  # 应用与依赖仍正常设 RPATH；独立 Node 保留官方字节并使用系统动态库。
  local real_patchelf
  real_patchelf="$(command -v patchelf)"
  PPCLASH_REAL_PATCHELF="$real_patchelf" PATCHELF="$ROOT/scripts/linux-runtime-patchelf.sh" NO_STRIP=1 \
    npm run tauri -- build --target "$target" --bundles deb,rpm,appimage
  local version dir ext dest
  version="$(node -p "require('./package.json').version")"
  for ext in deb rpm AppImage; do
    dir="src-tauri/target/$target/release/bundle/$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"
    dest="$dir/PP_Clash-${version}-linux-${PACKAGE_ARCH}.$ext"
    normalize_installer "$dir" "$ext" "$dest"
  done
}

scan() {
  log "公开仓库文件边界检查"
  node scripts/check-public-files.mjs
  log "敏感信息扫描"
  ./scripts/secret-scan.sh
}

case "${1:-check}" in
  install) install ;;
  prepare-service-engine) prepare_service_engine ;;
  check-workflows) check_workflows ;;
  preflight) preflight ;;
  build-web) build_web ;;
  check-web) check_web ;;
  check-rust) check_rust ;;
  check-resources) check_resources ;;
  check) check ;;
  build-macos) build_macos ;;
  build-macos-release) build_macos_release ;;
  build-windows) build_windows ;;
  build-windows-release) build_windows_release ;;
  build-linux-release) build_linux_release ;;
  normalize-windows-installer) normalize_windows_installer ;;
  scan) scan ;;
  *)
    echo "用法: $0 {preflight|prepare-service-engine|check-workflows|install|build-web|check-web|check-rust|check-resources|check|build-macos|build-macos-release|build-windows|build-windows-release|normalize-windows-installer|build-linux-release|scan}" >&2
    exit 2
    ;;
esac
