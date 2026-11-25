#!/usr/bin/env python3
"""Prepare a pinned, locally patched Mihomo build without changing module cache."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / 'scripts/android-core-patches/source-lock.json'
MODULE = 'github.com/metacubex/mihomo'
VERSION = 'v1.19.34'
FILES = {'hub/route/server.go', 'hub/route/configs.go', 'dns/server.go'}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def go(args, cwd):
    # A previous build's GOFLAGS/modfile must not affect source selection.
    environment = dict(os.environ, GOFLAGS='', GOWORK='off')
    result = subprocess.run(['go', *args], cwd=cwd, env=environment,
                            capture_output=True, text=True)
    if result.returncode:
        raise ValueError(f'go {args[0]} failed: {result.stderr.strip()}')
    return result.stdout.strip()


def writable_copy(source, target):
    for path in source.rglob('*'):
        if path.is_symlink():
            raise ValueError(f'Symlinks are not supported in build sources: {path}')
    shutil.copytree(source, target, copy_function=shutil.copyfile,
                    ignore=shutil.ignore_patterns('.git', '.cache'))
    for path in [target, *target.rglob('*')]:
        path.chmod(0o755 if path.is_dir() else 0o644)


def prepare(core, source, output, lock_path=LOCK):
    core, source, output = core.resolve(), source.resolve(), output.resolve()
    if output == source or output.is_relative_to(source) or source.is_relative_to(output):
        raise ValueError('Output must be separate from upstream sources')
    if output == core or output.is_relative_to(core) or core.is_relative_to(output):
        raise ValueError('Output must be separate from production core sources')
    lock = json.loads(lock_path.read_text())
    if lock.get('module') != MODULE or lock.get('version') != VERSION or set(lock.get('files', {})) != FILES:
        raise ValueError('Unsupported Mihomo source lock')
    if (source / 'go.mod').read_text().splitlines()[0].strip() != f'module {MODULE}':
        raise ValueError('Unexpected upstream module')
    patch = lock_path.parent / lock['patch']
    if patch.name != lock['patch'] or digest(patch) != lock['patchSha256']:
        raise ValueError('Mihomo patch integrity mismatch')
    for relative, entry in lock['files'].items():
        path = source / relative
        if path.is_symlink() or digest(path) != entry['sourceSha256']:
            raise ValueError(f'Mihomo {VERSION} source SHA mismatch: {relative}')
    original_mod, original_sum = core / 'go.mod', core / 'go.sum'
    production_hashes = {'go.mod': digest(original_mod), 'go.sum': digest(original_sum)}
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.android-core-stage-', dir=output.parent))
    backup = None
    try:
        writable_copy(source, stage / 'mihomo')
        applied = subprocess.run(['patch', '-p1', '--fuzz=0', '--batch', '--forward', '-i', str(patch)],
                                 cwd=stage / 'mihomo', capture_output=True, text=True)
        if applied.returncode:
            raise ValueError(f'Mihomo patch failed: {applied.stdout}{applied.stderr}')
        for relative, entry in lock['files'].items():
            if digest(stage / 'mihomo' / relative) != entry['patchedSha256']:
                raise ValueError(f'Patched Mihomo SHA mismatch: {relative}')
        # Gomobile creates its own generated module. A separate core workspace
        # supplies normal go.mod replacements without overriding that module.
        writable_copy(core, stage / 'core')
        shutil.copyfile(original_mod, stage / 'core.mod')
        shutil.copyfile(original_sum, stage / 'core.sum')
        replacement = f'{MODULE}@{VERSION}={output / "mihomo"}'
        for modfile in [stage / 'core.mod', stage / 'core/go.mod']:
            go(['mod', 'edit', '-modfile=' + str(modfile), '-replace=' + replacement], core)
        if output.exists():
            backup = Path(tempfile.mkdtemp(prefix='.android-core-previous-', dir=output.parent))
            backup.rmdir()
            output.rename(backup)
        stage.rename(output)
        selected = go(['list', '-mod=readonly', '-modfile=' + str(output / 'core.mod'),
                       '-m', '-f', '{{.Version}}', MODULE], core)
        if selected != VERSION:
            raise ValueError(f'Replacement lost the pinned version: {selected!r}')
        if production_hashes != {'go.mod': digest(original_mod), 'go.sum': digest(original_sum)}:
            raise ValueError('Production module files changed during preparation')
        metadata = {'module': MODULE, 'version': selected, 'moduleDir': str(output / 'mihomo'),
                    'modfile': str(output / 'core.mod'), 'goFlags': '-modfile=' + str(output / 'core.mod'),
                    'gomobileWorkdir': str(output / 'core'), 'gomobileGoFlags': '',
                    'ldflags': f'-X {MODULE}/constant.Version={VERSION}',
                    'productionModuleHashes': production_hashes, 'files': lock['files'],
                    'patchSha256': lock['patchSha256']}
        (output / 'prepared.json').write_text(json.dumps(metadata, indent=2) + '\n')
        if backup:
            shutil.rmtree(backup)
        print(f'Prepared Mihomo {VERSION}; explicit linker Version={VERSION}', file=sys.stderr)
        return metadata
    except BaseException:
        if not stage.exists() and output.exists():
            shutil.rmtree(output)
        if backup and backup.exists():
            backup.rename(output)
        raise
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--core-root', type=Path, default=ROOT / 'src-tauri/android-core')
    parser.add_argument('--source', type=Path, help='Optional already downloaded pinned module source')
    parser.add_argument('--output', type=Path, default=ROOT / '.cache/android-core-patched')
    args = parser.parse_args()
    cache = (ROOT / '.cache').resolve()
    if args.output.resolve() == cache or not args.output.resolve().is_relative_to(cache):
        parser.error('--output must be a child directory inside this project .cache')
    selected = json.loads(go(['list', '-mod=readonly', '-m', '-json', MODULE], args.core_root))
    if selected.get('Version') != VERSION or selected.get('Replace'):
        parser.error(f'Production module must select unreplaced {MODULE} {VERSION}')
    source = args.source or Path(selected['Dir'])
    print(json.dumps(prepare(args.core_root, source, args.output), indent=2))


if __name__ == '__main__':
    main()
