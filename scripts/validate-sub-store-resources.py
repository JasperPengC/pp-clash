#!/usr/bin/env python3
"""组包前及签名前验证所选架构的完整内置 Sub-Store 资源。"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import runpy
import stat
import sys

validate_binary = runpy.run_path(str(Path(__file__).with_name("validate-resources.py")))["validate_binary"]


def validate(root, arch, platform="macos"):
    target = {"macos": "darwin", "windows": "win", "linux": "linux", "android": "android"}[platform] + ("-x64" if arch == "x86_64" else "-arm64")
    executable = "node.exe" if platform == "windows" else "node"
    manifest_path = root / target / "manifest.json"
    if manifest_path.is_symlink() or not manifest_path.is_file() or manifest_path.stat().st_size > 64 * 1024:
        raise ValueError("资源清单缺失、类型无效或过大")
    manifest = json.loads(manifest_path.read_text())
    if type(manifest.get("schemaVersion")) is not int or (manifest.get("schemaVersion"), manifest.get("engineVersion"), manifest.get("nodeVersion"), manifest.get("target")) != (1, "2.44.16", "24.18.0", target):
        raise ValueError("资源版本或架构不匹配")
    expected = {"sub-store.bundle.cjs", "service-bootstrap.cjs", "build-provenance.json", "runtime-manifest.json",
                f"{target}/{executable}", f"{target}/LICENSE"}
    rows = manifest.get("files")
    if not isinstance(rows, list) or len(rows) != len(expected) or any(not isinstance(row, dict) for row in rows):
        raise ValueError("资源清单缺项或格式无效")
    names = [row.get("path") for row in rows]
    if any(not isinstance(name, str) for name in names) or len(set(names)) != len(names) or set(names) != expected:
        raise ValueError("资源清单路径缺失、重复或无效")
    for row in rows:
        path = root / row["path"]
        size = row.get("bytes")
        digest = row.get("sha256")
        if type(size) is not int or not 0 < size <= 256 * 1024 * 1024 or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError(f"资源大小或摘要格式无效: {row['path']}")
        if not stat.S_ISREG(path.lstat().st_mode) or path.stat().st_size != size:
            raise ValueError(f"资源缺失、类型或大小不匹配: {row['path']}")
        path.resolve().relative_to(root.resolve())
        sha = hashlib.sha256()
        with path.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                sha.update(block)
        if sha.hexdigest() != digest:
            raise ValueError(f"资源摘要不匹配: {row['path']}")
    node = root / target / executable
    if platform != "windows" and not node.stat().st_mode & 0o111:
        raise ValueError("Node 缺少可执行权限")
    with node.open("rb") as source:
        validate_binary(source.read(4096), "linux" if platform == "android" else platform, arch)
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("arch", choices=["x86_64", "aarch64"])
    parser.add_argument("--platform", choices=["macos", "windows", "linux", "android"], default="macos")
    args = parser.parse_args()
    try:
        target = validate(args.root, args.arch, args.platform)
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        print(f"Sub-Store 资源校验失败: {error}", file=sys.stderr)
        return 1
    print(f"Sub-Store 资源校验通过: {target}，6 项完整资源")
    return 0


if __name__ == "__main__":
    sys.exit(main())
