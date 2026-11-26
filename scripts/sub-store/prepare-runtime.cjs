// Prepare one target's complete runtime from a pinned official Node distribution.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const { prepareSharedEngine } = require('./prepare-shared.cjs');
const { downloadPinned } = require('./download-pinned.cjs');
const lock = require('./runtime-lock.json');
const upstream = require('./upstream-lock.json');
const args = process.argv.slice(2);
const shared = prepareSharedEngine(root);
if (args.includes('--shared-only')) {
  console.log('Prepared shared Sub-Store engine');
  process.exit(0);
}
const index = args.indexOf('--target');
const target = index < 0 ? `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}` : args[index + 1];
assert.ok(Object.hasOwn(lock.targets, target), `Unsupported runtime target: ${target}; Android has no supported complete Node service`);
const item = lock.targets[target];
const output = path.join(root, 'src-tauri/resources/sub-store');
const cache = path.join(root, '.cache/sub-store-runtime');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run = (cmd, argv, options = {}) => {
  const result = spawnSync(cmd, argv, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${cmd} failed`);
};
fs.mkdirSync(cache, { recursive: true });
const archive = path.join(cache, item.archive);
if (!fs.existsSync(archive)) {
  assert.ok(!args.includes('--offline'), `Missing offline archive: ${archive}`);
  downloadPinned(`${lock.distribution}${item.archive}`, archive, item.sha256);
}
assert.equal(sha(archive), item.sha256, 'Cached Node archive checksum mismatch');
const stage = fs.mkdtempSync(path.join(cache, 'prepare-'));
try {
  if (item.archive.endsWith('.zip')) {
    if (process.platform === 'win32') {
      const quote = (value) => `'${value.replace(/'/g, "''")}'`;
      // Let Windows PowerShell discover its own compatible modules instead of
      // inheriting a PowerShell 7 module path through Node or another parent.
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH'));
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(stage)}`], { env });
    } else run('unzip', ['-q', archive, '-d', stage]);
  } else {
    // Git for Windows tar treats a drive-letter colon in an absolute archive
    // path as a remote host separator. Both paths are relative to this cache.
    run('tar', ['-xzf', path.basename(archive), '-C', path.basename(stage)], { cwd: cache });
  }
  const extracted = path.join(stage, `node-v${lock.version}-${target}`);
  const executable = target.startsWith('win-') ? 'node.exe' : 'node';
  const binary = path.join(extracted, executable === 'node' ? 'bin/node' : executable);
  const targetDir = path.join(output, target);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(binary, path.join(targetDir, executable));
  if (executable === 'node') fs.chmodSync(path.join(targetDir, executable), 0o755);
  fs.copyFileSync(path.join(extracted, 'LICENSE'), path.join(targetDir, 'LICENSE'));
  fs.mkdirSync(path.join(root, 'licenses'), { recursive: true });
  fs.copyFileSync(path.join(extracted, 'LICENSE'), path.join(root, 'licenses/node.txt'));
  const describe = (name) => ({ path: name, sha256: sha(path.join(output, name)), bytes: fs.statSync(path.join(output, name)).size });
  const manifest = {
    schemaVersion: 1, engineVersion: upstream.version, nodeVersion: lock.version, target,
    archive: { url: `${lock.distribution}${item.archive}`, sha256: item.sha256 },
    files: [...shared, `${target}/${executable}`, `${target}/LICENSE`].map(describe),
  };
  fs.writeFileSync(path.join(targetDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Prepared ${target}: ${manifest.files.reduce((sum, file) => sum + file.bytes, 0)} bytes; ${path.join(targetDir, 'manifest.json')}`);
} finally { fs.rmSync(stage, { recursive: true, force: true }); }
