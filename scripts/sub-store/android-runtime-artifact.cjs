// Produce and consume immutable Android Node artifacts independently of service JS.
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const defaultRoot = path.resolve(__dirname, '../..');
const digest = (content) => crypto.createHash('sha256').update(content).digest('hex');
const fileDigest = (file) => digest(fs.readFileSync(file));
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const validSha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const targets = ['android-arm64', 'android-x64'];
const repository = 'https://github.com/JasperPengC/pp-clash';

function api(root) {
  return createRequire(path.join(root, 'scripts/sub-store/build-android-runtime.cjs'))('./build-android-runtime.cjs');
}

function expectedInput(root, target) {
  assert.ok(targets.includes(target), 'Unsupported Android runtime target');
  const input = api(root).buildInput(target, 'linux').input;
  // Linux x64 builds can be consumed on any packaging host.
  input.buildHost = 'linux-x64';
  return { input, sha256: digest(JSON.stringify(input)) };
}

function compileSources(root, input) {
  // The normalized build input already pins relevant lock values. Changes to
  // another host's lock metadata must not invalidate these Linux binaries.
  const names = ['scripts/sub-store/build-android-runtime.cjs', ...input.patches.map((patch) => patch.path)];
  return Object.fromEntries(names.map((name) => [name, fileDigest(path.join(root, name))]));
}

function checkFile(root, row) {
  assert.ok(validSha(row.sha256) && Number.isSafeInteger(row.bytes) && row.bytes > 0
    && row.bytes <= 256 * 1024 * 1024, 'Invalid runtime file record');
  const file = path.join(root, row.path);
  assert.ok(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(), 'Runtime file must be regular');
  assert.equal(fs.statSync(file).size, row.bytes, 'Runtime file size mismatch');
  assert.equal(fileDigest(file), row.sha256, 'Runtime file checksum mismatch');
}

function resourceFiles(root, target, manifest, version) {
  const names = ['sub-store.bundle.cjs', 'service-bootstrap.cjs', 'build-provenance.json',
    'runtime-manifest.json', `${target}/node`, `${target}/LICENSE`];
  assert.equal(manifest.schemaVersion, 1, 'Resource schema mismatch');
  assert.equal(manifest.target, target, 'Resource target mismatch');
  assert.equal(manifest.nodeVersion, version, 'Resource Node version mismatch');
  assert.ok(Array.isArray(manifest.files) && manifest.files.length === names.length, 'Incomplete runtime resources');
  assert.deepEqual([...manifest.files.map((row) => row.path)].sort(), [...names].sort(), 'Resource paths mismatch');
  for (const row of manifest.files) checkFile(root, row);
}

function checkBuild(root, target, sourceBuild) {
  const expected = expectedInput(root, target);
  assert.equal(sourceBuild.sha256, expected.sha256, 'Runtime build input mismatch');
  assert.equal(digest(JSON.stringify(sourceBuild.input)), expected.sha256, 'Runtime recorded input mismatch');
  assert.equal(sourceBuild.makeGoal, 'out/Release/node', 'Runtime was not a complete Node build');
  assert.equal(sourceBuild.nativeLibraryName, 'libppclash_node.so', 'Runtime native library mismatch');
  for (const key of ['configSha256', 'compilerSha256', 'linkerSha256', 'unstrippedSha256']) {
    assert.ok(validSha(sourceBuild[key]), `Missing runtime build provenance: ${key}`);
  }
  assert.ok(sourceBuild.compilerVersion && sourceBuild.hostCompilerVersion, 'Missing compiler provenance');
  assert.ok(Array.isArray(sourceBuild.licenseSources) && sourceBuild.licenseSources.length === 2
    && sourceBuild.licenseSources.every((row) => validSha(row.sha256)), 'Missing license provenance');
  return expected;
}

function archiveTool(command, first, second) {
  const result = spawnSync(process.env.PYTHON || 'python3',
    [path.join(__dirname, 'android-runtime-archive.py'), command, first, second], { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || 'Runtime archive operation failed');
}

function describe(root, name) {
  const file = path.join(root, name);
  return { path: name, bytes: fs.statSync(file).size, sha256: fileDigest(file) };
}

function checkArtifact(root, stage, target) {
  const manifest = read(path.join(stage, 'runtime.json'));
  assert.equal(manifest.schemaVersion, 1, 'Runtime artifact schema mismatch');
  assert.equal(manifest.target, target, 'Runtime artifact ABI mismatch');
  const input = checkBuild(root, target, manifest.sourceBuild);
  assert.equal(manifest.nodeVersion, input.input.nodeVersion, 'Runtime artifact version mismatch');
  const elf = api(root).verifyElf(path.join(stage, 'node'), target);
  assert.equal(elf.sha256, manifest.sourceBuild.elf.sha256, 'Runtime ELF provenance checksum mismatch');
  assert.deepEqual(manifest.files.map((row) => row.path).sort(), ['LICENSE', 'node', 'source-manifest.json'],
    'Runtime artifact file records mismatch');
  for (const row of manifest.files) checkFile(stage, row);
  const sources = compileSources(root, input.input);
  assert.deepEqual(manifest.compileSources, sources, 'Runtime compiler source changed');
  const frozen = read(path.join(stage, 'source-manifest.json'));
  assert.equal(manifest.sourceDigest, frozen.sourceDigest, 'Runtime source snapshot mismatch');
  for (const [name, sha] of Object.entries(sources)) {
    assert.equal(frozen.files[name], sha, `Runtime frozen source mismatch: ${name}`);
  }
  return manifest;
}

function withArchive(root, archive, target, callback) {
  const cache = path.join(root, '.cache/sub-store-android-artifacts');
  fs.mkdirSync(cache, { recursive: true });
  const stage = fs.mkdtempSync(path.join(cache, 'verify-'));
  try {
    archiveTool('unpack', archive, stage);
    return callback(checkArtifact(root, stage, target), stage);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

function artifactRecord(root, archive, target) {
  return withArchive(root, archive, target, (manifest) => ({
    archive: `android-node-${target}.tar.gz`, sha256: fileDigest(archive), bytes: fs.statSync(archive).size,
    inputSha256: manifest.sourceBuild.sha256,
    nodeSha256: manifest.files.find((row) => row.path === 'node').sha256,
    licenseSha256: manifest.files.find((row) => row.path === 'LICENSE').sha256,
    sourceBuildSha256: digest(JSON.stringify(manifest.sourceBuild)),
    sourceDigest: manifest.sourceDigest, compileSources: manifest.compileSources,
  }));
}

function readLock(root, file, target) {
  const lock = read(file);
  assert.equal(lock.schemaVersion, 1, 'Runtime artifact lock schema mismatch');
  const input = expectedInput(root, target);
  assert.equal(lock.nodeVersion, input.input.nodeVersion, 'Runtime artifact lock version mismatch');
  assert.match(lock.nodeVersion, /^\d+\.\d+\.\d+$/, 'Invalid pinned Node version');
  assert.match(lock.releaseTag, new RegExp(`^android-node-v${lock.nodeVersion.replaceAll('.', '\\.')}\u002d[a-f0-9]{16}$`), 'Invalid runtime release tag');
  assert.deepEqual(Object.keys(lock.targets).sort(), [...targets].sort(), 'Missing pinned runtime artifacts');
  const row = lock.targets[target];
  assert.equal(row.archive, `android-node-${target}.tar.gz`, 'Runtime archive name mismatch');
  assert.equal(row.url, `${repository}/releases/download/${lock.releaseTag}/${row.archive}`, 'Untrusted runtime artifact URL');
  for (const key of ['sha256', 'inputSha256', 'nodeSha256', 'licenseSha256', 'sourceBuildSha256', 'sourceDigest']) {
    assert.ok(validSha(row[key]), `Invalid pinned runtime digest: ${key}`);
  }
  assert.ok(Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= 256 * 1024 * 1024, 'Invalid archive size');
  assert.equal(row.inputSha256, input.sha256, 'Pinned runtime build input changed; build a new runtime dependency');
  assert.deepEqual(row.compileSources, compileSources(root, input.input), 'Pinned runtime compiler source changed');
  return row;
}

function pack(root, target, resources, frozenSource, output) {
  assert.ok(!fs.existsSync(output), 'Runtime artifact already exists; never overwrite it');
  const original = read(path.join(resources, target, 'manifest.json'));
  resourceFiles(resources, target, original, expectedInput(root, target).input.nodeVersion);
  const input = checkBuild(root, target, original.sourceBuild);
  const elf = api(root).verifyElf(path.join(resources, target, 'node'), target);
  assert.equal(elf.sha256, original.sourceBuild.elf.sha256, 'Producer ELF checksum mismatch');
  const frozen = read(frozenSource);
  const sources = compileSources(root, input.input);
  for (const [name, sha] of Object.entries(sources)) assert.equal(frozen.files[name], sha, `Producer source mismatch: ${name}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const stage = fs.mkdtempSync(path.join(path.dirname(output), 'pack-'));
  try {
    for (const name of ['node', 'LICENSE']) fs.copyFileSync(path.join(resources, target, name), path.join(stage, name));
    fs.copyFileSync(frozenSource, path.join(stage, 'source-manifest.json'));
    const manifest = { schemaVersion: 1, nodeVersion: input.input.nodeVersion, target,
      sourceBuild: original.sourceBuild, sourceDigest: frozen.sourceDigest, compileSources: sources,
      files: ['node', 'LICENSE', 'source-manifest.json'].map((name) => describe(stage, name)) };
    fs.writeFileSync(path.join(stage, 'runtime.json'), json(manifest));
    archiveTool('pack', stage, output);
    return { target, ...artifactRecord(root, output, target) };
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

function makeLock(root, arm64, x64, output) {
  const records = Object.fromEntries(targets.map((target, index) =>
    [target, artifactRecord(root, [arm64, x64][index], target)]));
  const version = expectedInput(root, targets[0]).input.nodeVersion;
  const releaseTag = `android-node-v${version}-${digest(JSON.stringify(Object.fromEntries(
    targets.map((target) => [target, records[target].sha256])))).slice(0, 16)}`;
  for (const row of Object.values(records)) row.url = `${repository}/releases/download/${releaseTag}/${row.archive}`;
  const lock = { schemaVersion: 1, nodeVersion: version, releaseTag, targets: records };
  fs.writeFileSync(output, json(lock));
  return lock;
}

function prepare(root, target, lockFile, suppliedArchive, offline) {
  const row = readLock(root, lockFile, target);
  const output = path.join(root, 'src-tauri/resources/sub-store');
  const cache = path.join(root, '.cache/sub-store-android-artifacts');
  fs.mkdirSync(cache, { recursive: true });
  const archive = suppliedArchive || path.join(cache, `${row.sha256}-${row.archive}`);
  if (!fs.existsSync(archive)) {
    assert.ok(!offline && !suppliedArchive, 'Missing pinned runtime archive; no implicit source build');
    const partial = `${archive}.partial`;
    const result = spawnSync('curl', ['--fail', '--location', '--silent', '--show-error',
      '--connect-timeout', '30', '--max-time', '300', '--output', partial, row.url], { encoding: 'utf8' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `Pinned runtime download failed; no source build fallback: ${result.stderr}`);
    assert.equal(fs.statSync(partial).size, row.bytes, 'Downloaded runtime size mismatch');
    assert.equal(fileDigest(partial), row.sha256, 'Downloaded runtime checksum mismatch');
    fs.renameSync(partial, archive);
  }
  assert.ok(fs.lstatSync(archive).isFile() && !fs.lstatSync(archive).isSymbolicLink(), 'Runtime archive must be regular');
  assert.equal(fs.statSync(archive).size, row.bytes, 'Runtime archive checksum/size mismatch');
  assert.equal(fileDigest(archive), row.sha256, 'Runtime archive checksum mismatch');
  return withArchive(root, archive, target, (metadata, stage) => {
    assert.equal(digest(JSON.stringify(metadata.sourceBuild)), row.sourceBuildSha256, 'Runtime provenance checksum mismatch');
    assert.equal(metadata.sourceDigest, row.sourceDigest, 'Runtime source snapshot mismatch');
    assert.equal(fileDigest(path.join(stage, 'node')), row.nodeSha256, 'Pinned Node checksum mismatch');
    assert.equal(fileDigest(path.join(stage, 'LICENSE')), row.licenseSha256, 'Pinned license checksum mismatch');
    const shared = createRequire(path.join(root, 'scripts/sub-store/prepare-shared.cjs'))('./prepare-shared.cjs').prepareSharedEngine(root);
    const directory = path.join(output, target);
    fs.mkdirSync(directory, { recursive: true });
    for (const name of ['node', 'LICENSE']) fs.copyFileSync(path.join(stage, name), path.join(directory, name));
    fs.chmodSync(path.join(directory, 'node'), 0o755);
    const upstream = read(path.join(root, 'scripts/sub-store/upstream-lock.json'));
    const manifest = { schemaVersion: 1, engineVersion: upstream.version, nodeVersion: metadata.nodeVersion, target,
      archive: metadata.sourceBuild.input.source, sourceBuild: metadata.sourceBuild, runtimeArtifact: row,
      files: [...shared, `${target}/node`, `${target}/LICENSE`].map((name) => describe(output, name)) };
    fs.writeFileSync(path.join(directory, 'manifest.json'), json(manifest));
    return { target, nodeSha256: row.nodeSha256, archiveSha256: row.sha256, preparedWithoutCompilation: true };
  });
}

function verifySharedEngine(root, resources) {
  const engine = path.join(root, '.cache/cloud-tools-20261121/runtime');
  const upstream = read(path.join(root, 'scripts/sub-store/upstream-lock.json'));
  const provenance = read(path.join(engine, 'build-provenance.json'));
  for (const key of Object.keys(upstream)) {
    assert.equal(provenance[key], upstream[key], `Current shared engine provenance mismatch: ${key}`);
  }
  assert.equal(provenance.patch, 'scripts/sub-store/strict-errors.patch', 'Current shared engine patch mismatch');
  assert.equal(fileDigest(path.join(root, provenance.patch)), provenance.patchSha256, 'Current shared engine patch changed');
  assert.equal(fileDigest(path.join(engine, 'sub-store.strict.bundle.cjs')), provenance.output.bundle.sha256,
    'Current shared engine bundle checksum mismatch');
  assert.equal(fileDigest(path.join(engine, 'runtime-manifest-strict.json')), provenance.output.manifest.sha256,
    'Current shared engine manifest checksum mismatch');
  for (const [source, destination] of [
    ['sub-store.strict.bundle.cjs', 'sub-store.bundle.cjs'],
    ['build-provenance.json', 'build-provenance.json'],
    ['runtime-manifest-strict.json', 'runtime-manifest.json'],
  ]) {
    assert.equal(fileDigest(path.join(resources, destination)), fileDigest(path.join(engine, source)),
      `Resources do not match the current shared engine: ${destination}`);
  }
}

function verify(root, target, lockFile, resources) {
  const row = readLock(root, lockFile, target);
  const manifest = read(path.join(resources, target, 'manifest.json'));
  resourceFiles(resources, target, manifest, expectedInput(root, target).input.nodeVersion);
  checkBuild(root, target, manifest.sourceBuild);
  verifySharedEngine(root, resources);
  assert.deepEqual(manifest.runtimeArtifact, row, 'Resource runtime artifact identity mismatch');
  assert.equal(digest(JSON.stringify(manifest.sourceBuild)), row.sourceBuildSha256, 'Resource runtime provenance changed');
  assert.equal(fileDigest(path.join(resources, target, 'node')), row.nodeSha256, 'Resource pinned Node checksum mismatch');
  assert.equal(fileDigest(path.join(resources, target, 'LICENSE')), row.licenseSha256, 'Resource pinned license checksum mismatch');
  api(root).verifyElf(path.join(resources, target, 'node'), target);
  return { target, status: 'verified', nodeSha256: row.nodeSha256 };
}

function main(args) {
  const command = args[0];
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    if (index < 0) { assert.ok(fallback !== undefined, `Missing ${name}`); return fallback; }
    assert.ok(args[index + 1] && !args[index + 1].startsWith('--'), `Missing value for ${name}`);
    return args[index + 1];
  };
  const root = path.resolve(option('--root', defaultRoot));
  const lock = () => path.resolve(option('--lock', path.join(root, 'scripts/sub-store/android-runtime-artifacts-lock.json')));
  const resources = () => path.resolve(option('--resources', path.join(root, 'src-tauri/resources/sub-store')));
  let value;
  if (command === 'pack') value = pack(root, option('--target'), resources(), path.resolve(option('--source-manifest')), path.resolve(option('--output')));
  else if (command === 'lock') value = makeLock(root, path.resolve(option('--arm64')), path.resolve(option('--x64')), path.resolve(option('--output')));
  else if (command === 'prepare') value = prepare(root, option('--target'), lock(), args.includes('--archive') ? path.resolve(option('--archive')) : null, args.includes('--offline'));
  else if (command === 'verify') value = verify(root, option('--target'), lock(), resources());
  else throw new Error('Use pack, lock, prepare or verify; source builds require the independent builder');
  console.log(json(value));
}

module.exports = { pack, makeLock, prepare, verify, expectedInput };
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`Android runtime artifact error: ${error.message}`); process.exitCode = 1; }
}
