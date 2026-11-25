#!/usr/bin/env bash
# linuxdeploy 扫描 AppDir 内全部 ELF；官方 Node 必须保留锁定字节。
set -euo pipefail
if [ "${1:-}" = --set-rpath ] && [ "$#" -eq 3 ]; then
  case "$3" in
    *.AppDir/*/sub-store/linux-x64/node|*.AppDir/*/sub-store/linux-arm64/node)
      echo "保留官方 Node 的原始 ELF：$3" >&2
      exit 0
      ;;
  esac
fi
exec "${PPCLASH_REAL_PATCHELF:?必须配置真实 patchelf 路径}" "$@"
