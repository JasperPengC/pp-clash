// 从固定上游源码重建完整引擎；所有源码、依赖和产物均位于隔离缓存目录。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { downloadPinned } = require('./download-pinned.cjs');

const root = path.resolve(__dirname, '../..');
const cache = path.join(root, '.cache/sub-store-reference-20261121');
const runtime = path.join(root, '.cache/cloud-tools-20261121/runtime');
const lock = require('./upstream-lock.json');
const patch = path.join(__dirname, 'strict-errors.patch');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const corepack = process.env.SUB_STORE_COREPACK_PNPM || path.join(__dirname, 'toolchain/node_modules/corepack/dist/pnpm.js');
assert.ok(fs.existsSync(corepack), 'Set SUB_STORE_COREPACK_PNPM to the installed corepack/dist/pnpm.js');
assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Build requires Node.js >= 24');
fs.mkdirSync(cache, { recursive: true });
fs.mkdirSync(runtime, { recursive: true });
const env = {
  ...process.env,
  PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
  COREPACK_HOME: path.join(cache, 'corepack'),
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  npm_config_cache: path.join(cache, 'npm-cache'),
  pnpm_config_fetch_timeout: '300000',
  pnpm_config_fetch_retries: '3',
  XDG_CACHE_HOME: path.join(cache, 'xdg-cache'),
  PNPM_HOME: path.join(cache, 'pnpm-home'),
  LC_ALL: 'C',
};
function run(command, args, cwd = root, log) {
  const output = log ? fs.openSync(log, 'w') : undefined;
  try {
    const result = spawnSync(command, args, { cwd, env, stdio: log ? ['ignore', output, output] : 'inherit' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${command} failed; see ${log || 'output'}`);
  } finally {
    if (output !== undefined) fs.closeSync(output);
  }
}

const archive = path.join(cache, `upstream-${lock.version}.tar.gz`);
downloadPinned(`https://codeload.github.com/${lock.repository}/tar.gz/${lock.commit}`, archive, lock.archiveSha256);
assert.equal(sha256(archive), lock.archiveSha256, 'Upstream archive checksum mismatch');
const workspace = fs.mkdtempSync(path.join(cache, 'build-'));
run('tar', ['-xzf', archive, '-C', workspace]);
const source = path.join(workspace, `Sub-Store-${lock.commit}`);
const backend = path.join(source, 'backend');
assert.equal(sha256(path.join(backend, 'pnpm-lock.yaml')), lock.upstreamLockSha256, 'Upstream dependency lock checksum mismatch');
assert.equal(require(path.join(backend, 'package.json')).packageManager, lock.packageManager);
run('patch', ['--batch', '--fuzz=0', '-p1', '-i', patch], source);
run(process.execPath, [corepack, 'install', '--frozen-lockfile', '--store-dir', path.join(cache, 'pnpm-store'), '--ignore-scripts'], backend, path.join(runtime, 'strict-install.log'));
run(process.execPath, ['bundle-esbuild.js'], backend, path.join(runtime, 'strict-build.log'));
const bundle = path.join(runtime, 'sub-store.strict.bundle.cjs');
const manifest = path.join(runtime, 'runtime-manifest-strict.json');
fs.copyFileSync(path.join(backend, 'dist/sub-store.bundle.js'), bundle);
fs.copyFileSync(path.join(backend, 'dist/runtime-manifest.json'), manifest);
const provenance = {
  ...lock,
  source,
  patch: path.relative(root, patch),
  patchSha256: sha256(patch),
  adaptedLockSha256: sha256(path.join(backend, 'pnpm-lock.yaml')),
  actualBuildNode: process.version,
  platform: process.platform,
  arch: process.arch,
  buildCommand: [process.execPath, 'bundle-esbuild.js'],
  builtAt: new Date().toISOString(),
  output: {
    bundle: { path: bundle, sha256: sha256(bundle), bytes: fs.statSync(bundle).size },
    manifest: { path: manifest, sha256: sha256(manifest), bytes: fs.statSync(manifest).size },
  },
};
fs.writeFileSync(path.join(runtime, 'build-provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(`Built ${bundle}\nSHA-256 ${provenance.output.bundle.sha256}`);
