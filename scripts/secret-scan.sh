#!/usr/bin/env bash
# 公开仓库候选源码扫描：由 Node 统一处理 Windows / CRLF / 文件名边界。
set -euo pipefail
exec node "$(dirname "$0")/secret-scan.mjs"
