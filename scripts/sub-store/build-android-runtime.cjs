// Build complete Android Node executables from the pinned official source.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const lock = require('./android-runtime-lock.json');
const upstream = require('./upstream-lock.json');
const { prepareSharedEngine } = require('./prepare-shared.cjs');
const { downloadPinned } = require('./download-pinned.cjs');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const fileSha = (file) => sha(fs.readFileSync(file));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readNodeConfig = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^#.*(?:\r?\n|$)/gm, ''));

function buildInput(target, host = process.platform) {
  assert.ok(Object.hasOwn(lock.targets, target), `Unsupported Android target: ${target}`);
  assert.ok(['darwin', 'linux'].includes(host), `Unsupported Android build host: ${host}`);
  const patches = [lock.androidPatch, ...(host === 'darwin' ? [lock.darwinPatch] : [])];
  for (const patch of patches) assert.equal(fileSha(path.join(root, patch.path)), patch.sha256, 'Android source patch checksum mismatch');
  const input = {
    schemaVersion: 1, nodeVersion: lock.version, source: lock.source,
    target, architecture: lock.targets[target], buildHost: `${host}-${process.arch}`,
    ndkVersion: lock.ndkVersion, androidApi: lock.androidApi, pageSize: lock.pageSize,
    features: lock.features, configure: [`--dest-cpu=${lock.targets[target].arch}`, ...lock.configure],
    targetLdflags: lock.targetLdflags, hostLdflags: host === 'darwin' ? lock.darwinHostLdflags : [], patches,
  };
  return { input, sha256: sha(JSON.stringify(input)) };
}

function verifyInput(file, expected) {
  const previous = readJson(file);
  assert.equal(sha(JSON.stringify(previous.input)), previous.sha256, 'Build input mismatch: recorded data was changed');
  assert.equal(previous.sha256, expected.sha256, 'Build input mismatch: use a separate source directory for changed inputs');
}

function verifyElf(file, target) {
  const item = lock.targets[target];
  assert.ok(item, `Unsupported Android target: ${target}`);
  const b = fs.readFileSync(file);
  assert.ok(b.length >= 64 && b.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])), 'Expected an Android ELF executable');
  assert.equal(b[4], 2, 'Expected ELF64');
  assert.equal(b[5], 1, 'Expected little-endian ELF');
  assert.equal(b.readUInt16LE(16), 3, 'Android ELF must be a PIE executable (ET_DYN)');
  const machine = b.readUInt16LE(18);
  assert.equal(machine, item.elfMachine, `ELF architecture mismatch for ${target}`);
  assert.ok(b.readBigUInt64LE(24) > 0n, 'Android ELF must have an executable entry point');
  const num = (offset) => { const n = Number(b.readBigUInt64LE(offset)); assert.ok(Number.isSafeInteger(n), 'ELF offset overflow'); return n; };
  const headers = [];
  const phoff = num(32), phsize = b.readUInt16LE(54), phnum = b.readUInt16LE(56);
  assert.ok(phsize >= 56 && phoff + phsize * phnum <= b.length, 'Invalid ELF program headers');
  for (let i = 0; i < phnum; i++) {
    const p = phoff + phsize * i;
    headers.push({ type: b.readUInt32LE(p), offset: num(p + 8), address: num(p + 16), bytes: num(p + 32), align: num(p + 48) });
  }
  const interp = headers.find((h) => h.type === 3);
  assert.ok(interp && interp.offset + interp.bytes <= b.length, 'Android ELF has no interpreter');
  const interpreter = b.subarray(interp.offset, interp.offset + interp.bytes).toString().replace(/\0.*$/s, '');
  assert.equal(interpreter, '/system/bin/linker64', 'ELF interpreter must be Android /system/bin/linker64');
  const loads = headers.filter((h) => h.type === 1);
  assert.ok(loads.length && loads.every((h) => h.align >= lock.pageSize && h.align % lock.pageSize === 0), 'Android ELF LOAD segments require 16KB page alignment');
  let androidApi = null, ndk = null;
  const aligned = (n) => (n + 3) & ~3;
  for (const h of headers.filter((h) => h.type === 4)) {
    for (let p = h.offset; p + 12 <= h.offset + h.bytes;) {
      const namesz = b.readUInt32LE(p), descsz = b.readUInt32LE(p + 4), type = b.readUInt32LE(p + 8);
      const desc = p + 12 + aligned(namesz), next = desc + aligned(descsz);
      assert.ok(next <= b.length && next <= h.offset + h.bytes && next > p, 'Invalid ELF note');
      const name = b.subarray(p + 12, p + 12 + namesz).toString().replace(/\0.*$/s, '');
      if (name === 'Android' && type === 1 && descsz >= 4) {
        androidApi = b.readUInt32LE(desc);
        if (descsz >= 68) ndk = b.subarray(desc + 4, desc + 68).toString().replace(/\0.*$/s, '');
      }
      p = next;
    }
  }
  assert.equal(androidApi, lock.androidApi, 'Android ELF API note differs from the pinned minimum SDK');
  const dynamic = headers.find((h) => h.type === 2);
  assert.ok(dynamic, 'Android ELF must retain its dynamic system-library table');
  const entries = [];
  for (let p = dynamic.offset; p + 16 <= dynamic.offset + dynamic.bytes; p += 16) {
    const tag = num(p), value = num(p + 8);
    if (tag === 0) break;
    entries.push({ tag, value });
  }
  const strtab = entries.find((e) => e.tag === 5);
  assert.ok(strtab, 'Missing ELF dynamic strings');
  const segment = loads.find((h) => strtab.value >= h.address && strtab.value < h.address + h.bytes);
  assert.ok(segment, 'Invalid ELF dynamic strings address');
  const stringOffset = segment.offset + strtab.value - segment.address;
  const needed = entries.filter((e) => e.tag === 1).map((e) => {
    const start = stringOffset + e.value, end = b.indexOf(0, start);
    assert.ok(end >= start, 'Invalid ELF dependency name');
    return b.subarray(start, end).toString();
  });
  const allowed = ['libc.so', 'libm.so', 'libdl.so', 'liblog.so'];
  assert.ok(needed.every((name) => allowed.includes(name)), `Android ELF has unsupported dynamic dependencies: ${needed.join(', ')}`);
  assert.ok(needed.includes('libc.so'), 'Android ELF must use Bionic libc.so');
  return { format: 'ELF64-PIE', machine, interpreter, androidApi, ndk, loadAlignment: Math.min(...loads.map((h) => h.align)), needed, bytes: b.length, sha256: sha(b) };
}

function verifySmoke(report, target, binarySha256) {
  assert.equal(report.nodeVersion, lock.version, 'Android smoke Node version mismatch');
  assert.equal(report.platform, 'android', 'Android smoke must execute on Android');
  assert.equal(report.arch, lock.targets[target].arch, 'Android smoke ABI mismatch');
  assert.equal(report.runtimeSha256, binarySha256, 'Android smoke executable checksum mismatch');
  assert.ok(/^\/data\/app\/.+\/lib\/(arm64|x86_64)\/libppclash_node\.so$/.test(report.execPath), 'Android smoke must execute the APK-installed native library');
  for (const feature of ['worker_threads', 'child_process', 'sqlite']) assert.equal(report[feature], 'ok', `Android smoke failed: ${feature}`);
  assert.ok(['TLSv1.2', 'TLSv1.3'].includes(report.tls), 'Android smoke TLS handshake failed');
  return { status: 'passed', report };
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${cmd} failed; see the build log`);
}

function prepare(target, source, input, env, ndkTools, smokeFile) {
  const binary = path.join(source, 'out/Release/node');
  const unstrippedElf = verifyElf(binary, target);
  const config = readNodeConfig(path.join(source, 'config.gypi'));
  assert.equal(config.variables.target_arch, lock.targets[target].arch, 'Built Node target architecture mismatch');
  assert.equal(config.variables.node_use_sqlite, 'true', 'Built Node must include sqlite');
  assert.equal(config.variables.node_use_openssl, 'true', 'Built Node must include TLS/OpenSSL');
  const output = path.join(root, 'src-tauri/resources/sub-store');
  const shared = prepareSharedEngine(root);
  const targetDir = path.join(output, target);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(binary, path.join(targetDir, 'node'));
  run(path.join(ndkTools, 'llvm-strip'), ['--strip-debug', path.join(targetDir, 'node')]);
  const elf = verifyElf(path.join(targetDir, 'node'), target);
  fs.chmodSync(path.join(targetDir, 'node'), 0o755);
  const nodeLicense = fs.readFileSync(path.join(source, 'LICENSE'));
  const llvmNotice = fs.readFileSync(path.join(ndkTools, '../NOTICE'));
  fs.writeFileSync(path.join(targetDir, 'LICENSE'), Buffer.concat([nodeLicense, Buffer.from('\n\n---- Android static libc++ / LLVM runtime ----\n\n'), llvmNotice]));
  const describe = (name) => ({ path: name, sha256: fileSha(path.join(output, name)), bytes: fs.statSync(path.join(output, name)).size });
  const manifest = {
    schemaVersion: 1, engineVersion: upstream.version, nodeVersion: lock.version, target,
    archive: { url: lock.source.url, sha256: lock.source.sha256 },
    sourceBuild: { ...input, licenseSources: [
      { source: 'Node source LICENSE', sha256: sha(nodeLicense) },
      { source: 'Android NDK LLVM toolchain NOTICE', sha256: sha(llvmNotice) },
    ], configSha256: fileSha(path.join(source, 'config.gypi')), compiler: env.CXX,
      compilerVersion: spawnSync(env.CXX, ['--version'], { encoding: 'utf8' }).stdout.split('\n')[0],
      compilerSha256: fileSha(fs.realpathSync(path.join(ndkTools, 'clang'))),
      linkerSha256: fileSha(fs.realpathSync(path.join(ndkTools, 'ld.lld'))),
      hostCompiler: env.CXX_host, hostCompilerVersion: spawnSync(env.CXX_host, ['--version'], { encoding: 'utf8' }).stdout.split('\n')[0], makeGoal: 'out/Release/node', deviceSmoke: smokeFile ? verifySmoke(readJson(smokeFile), target, elf.sha256) : { status: 'pending' }, unstrippedSha256: unstrippedElf.sha256, strip: ['llvm-strip', '--strip-debug'], elf, nativeLibraryName: 'libppclash_node.so' },
    files: [...shared, `${target}/node`, `${target}/LICENSE`].map(describe),
  };
  fs.writeFileSync(path.join(targetDir, 'manifest.json'), json(manifest));
  console.log(`Prepared ${target}: ${elf.bytes} bytes, Android API ${elf.androidApi}, ${elf.loadAlignment} byte LOAD alignment`);
}

function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const at = args.indexOf(name);
    if (at < 0) return fallback;
    assert.ok(args[at + 1] && !args[at + 1].startsWith('--'), `Missing value for ${name}`);
    return args[at + 1];
  };
  const target = option('--target', 'android-arm64');
  if (args.includes('--verify-elf')) {
    const elf = verifyElf(option('--verify-elf'), target);
    if (args.includes('--smoke-result')) elf.deviceSmoke = verifySmoke(readJson(option('--smoke-result')), target, elf.sha256);
    return process.stdout.write(json(elf));
  }
  const input = buildInput(target);
  if (args.includes('--print-input')) return process.stdout.write(json(input));
  if (args.includes('--verify-input')) { verifyInput(option('--verify-input'), input); return console.log('Build input verified'); }
  const ndk = path.resolve(option('--ndk', process.env.ANDROID_NDK_HOME || path.join(root, '.cache/android-sdk/ndk', lock.ndkVersion)));
  const properties = fs.readFileSync(path.join(ndk, 'source.properties'), 'utf8');
  assert.ok(properties.includes(`Pkg.Revision = ${lock.ndkVersion}`), 'Pinned Android NDK revision mismatch');
  const ndkTools = path.join(ndk, 'toolchains/llvm/prebuilt', `${process.platform === 'darwin' ? 'darwin' : 'linux'}-x86_64/bin`);
  const cache = path.resolve(option('--cache', path.join(root, '.cache/sub-store-android')));
  fs.mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, lock.source.archive);
  if (!fs.existsSync(archive)) {
    assert.ok(!args.includes('--offline'), `Missing offline source archive: ${archive}`);
    downloadPinned(lock.source.url, archive, lock.source.sha256);
  }
  assert.equal(fileSha(archive), lock.source.sha256, 'Cached Node source archive checksum mismatch');
  const source = path.resolve(option('--source-dir', path.join(cache, target, `node-v${lock.version}`)));
  const record = path.join(source, '.ppclash-android-build-input.json');
  if (fs.existsSync(record)) verifyInput(record, input);
  if (!fs.existsSync(source)) {
    fs.mkdirSync(path.dirname(source), { recursive: true });
    run('tar', ['-xJf', archive, '-C', path.dirname(source)]);
  }
  const versionHeader = fs.readFileSync(path.join(source, 'src/node_version.h'), 'utf8');
  for (const [i, part] of lock.version.split('.').entries()) {
    assert.ok(new RegExp(`#define NODE_${['MAJOR', 'MINOR', 'PATCH'][i]}_VERSION\\s+${part}\\b`).test(versionHeader), 'Node source version mismatch');
  }
  for (const patch of input.input.patches) {
    const states = Object.entries(patch.files).map(([name, hashes]) => ({ name, hashes, actual: fileSha(path.join(source, name)) }));
    if (states.every((s) => s.actual === s.hashes.before)) run('patch', ['-p1', '--forward', '-i', path.join(root, patch.path)], { cwd: source });
    for (const s of states) assert.equal(fileSha(path.join(source, s.name)), s.hashes.after, `Patched Node source checksum mismatch: ${s.name}`);
  }
  fs.writeFileSync(record, json(input));
  const hostCc = option('--host-cc', process.platform === 'darwin' ? '/usr/bin/clang' : 'cc');
  const hostCxx = option('--host-cxx', process.platform === 'darwin' ? '/usr/bin/clang++' : 'c++');
  const item = lock.targets[target];
  const python = option('--python', process.env.PYTHON || 'python3');
  const env = {
    ...process.env, LC_ALL: 'C', LANG: 'C', CC_host: hostCc, CXX_host: hostCxx,
    CC: path.join(ndkTools, `${item.triple}${lock.androidApi}-clang`), CXX: path.join(ndkTools, `${item.triple}${lock.androidApi}-clang++`),
    AR: path.join(ndkTools, 'llvm-ar'),
    GYP_DEFINES: `target_arch=${item.arch} v8_target_arch=${item.arch} android_target_arch=${item.arch} host_os=${process.platform === 'darwin' ? 'mac' : 'linux'} OS=android android_ndk_path=${ndk}`,
    PATH: `${path.dirname(path.resolve(python))}:${ndkTools}${path.delimiter}${process.env.PATH}`,
  };
  const jobs = Number(option('--jobs', '3'));
  assert.ok(Number.isInteger(jobs) && jobs >= 1 && jobs <= 8, '--jobs must be between 1 and 8');
  if (!args.includes('--prepare-only')) {
    run(python, ['configure', ...input.input.configure], { cwd: source, env });
    if (args.includes('--configure-only')) return console.log(`Configured ${target}: ${source}`);
    const logFile = path.join(cache, `build-${target}.log`);
    const log = fs.openSync(logFile, 'a');
    console.log(`Building ${target}; log: ${logFile}`);
    try { run('make', [`-j${jobs}`, '-C', 'out', 'BUILDTYPE=Release', 'V=0', path.join(source, 'out/Release/node'), `LDFLAGS.target=${lock.targetLdflags.join(' ')}`, `LDFLAGS.host=${input.input.hostLdflags.join(' ')}`], { cwd: source, env, stdio: ['ignore', log, log] }); }
    finally { fs.closeSync(log); }
  }
  prepare(target, source, input, env, ndkTools, option('--smoke-result'));
}

module.exports = { buildInput, verifyInput, verifyElf, verifySmoke, readNodeConfig };
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
