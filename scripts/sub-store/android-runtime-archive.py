"""Create deterministic runtime archives and extract only bounded regular files."""
import gzip
import hashlib
import json
from pathlib import Path
import sys
import tarfile

LIMITS = {'node': 256 * 1024 * 1024, 'LICENSE': 8 * 1024 * 1024,
          'runtime.json': 64 * 1024, 'source-manifest.json': 1024 * 1024}


def check_source(root):
    value = json.loads((root / 'source-manifest.json').read_text())
    files = value.get('files')
    if not isinstance(files, dict) or not files:
        raise ValueError('Archive source manifest is missing')
    actual = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
    if actual != value.get('sourceDigest'):
        raise ValueError('Archive source manifest digest mismatch')


def pack(root, archive):
    check_source(root)
    if {p.name for p in root.iterdir()} != set(LIMITS):
        raise ValueError('Archive must contain exactly four runtime files')
    with archive.open('xb') as raw:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as stream:
                for name, limit in LIMITS.items():
                    file = root / name
                    if file.is_symlink() or not file.is_file() or not 0 < file.stat().st_size <= limit:
                        raise ValueError('Archive file is invalid: ' + name)
                    info = tarfile.TarInfo(name)
                    info.size = file.stat().st_size
                    info.mode = 0o755 if name == 'node' else 0o644
                    with file.open('rb') as content:
                        stream.addfile(info, content)


def unpack(archive, root):
    seen = set()
    with tarfile.open(archive, mode='r|gz') as stream:
        for member in stream:
            if (member.name not in LIMITS or member.name in seen
                    or member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE)
                    or member.pax_headers or not 0 < member.size <= LIMITS.get(member.name, 0)):
                raise ValueError('Unsafe runtime archive entry: ' + member.name)
            seen.add(member.name)
            file = root / member.name
            with stream.extractfile(member) as content, file.open('xb') as output:
                remaining = member.size
                while remaining:
                    block = content.read(min(remaining, 1024 * 1024))
                    if not block:
                        raise ValueError('Truncated runtime archive entry')
                    output.write(block)
                    remaining -= len(block)
            file.chmod(0o755 if member.name == 'node' else 0o644)
    if seen != set(LIMITS):
        raise ValueError('Runtime archive is missing required files')
    check_source(root)


if __name__ == '__main__':
    try:
        command, first, second = sys.argv[1:]
        if command == 'pack':
            pack(Path(first), Path(second))
        elif command == 'unpack':
            unpack(Path(first), Path(second))
        else:
            raise ValueError('Unknown archive operation')
    except (OSError, ValueError, KeyError, TypeError, tarfile.TarError) as error:
        print('Runtime archive error: ' + str(error), file=sys.stderr)
        sys.exit(1)
