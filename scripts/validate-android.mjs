import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { verifyElf } = require('./sub-store/build-android-runtime.cjs');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

const [directory, version, mode] = process.argv.slice(2);
if (!directory || !/^\d+\.\d+\.\d+$/.test(version) || !['debug', 'release'].includes(mode)) {
  throw new Error('Usage: validate-android.mjs <directory> <version> <debug|release>');
}
const sdk = process.env.ANDROID_HOME;
if (!sdk) throw new Error('ANDROID_HOME is required');
const buildTools = join(sdk, 'build-tools', '36.0.0');
const run = (tool, args) => execFileSync(tool, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const geodata = readFileSync(new URL('../src-tauri/android-core/mobile/geodata.zip', import.meta.url));
if (geodata.length < 1024 * 1024) throw new Error('Android offline geodata is missing or invalid');
const expectedCertificate = process.env.PPCLASH_ANDROID_CERT_SHA256?.replaceAll(':', '').toLowerCase();
if (mode === 'release' && !/^[a-f0-9]{64}$/.test(expectedCertificate ?? '')) {
  throw new Error('A valid pinned Android certificate SHA-256 is required for release validation');
}
let certificate;
for (const abi of ['arm64-v8a', 'x86_64']) {
  const apk = join(directory, `ppclash-android-${abi}-v${version}.apk`);
  if (!existsSync(apk) || statSync(apk).size === 0 || statSync(apk).size > 160 * 1024 * 1024) {
    throw new Error(`Missing, empty or oversized APK: ${abi}`);
  }
  const entries = run('unzip', ['-Z1', apk]).trim().split('\n');
  const libraries = entries.filter(name => name.startsWith('lib/') && name.endsWith('.so'));
  if (libraries.some(name => name.split('/')[1] !== abi)
      || !libraries.includes(`lib/${abi}/libppclash_lib.so`) || !libraries.includes(`lib/${abi}/libgojni.so`) || !libraries.includes(`lib/${abi}/libppclash_node.so`)) {
    throw new Error(`APK has missing or mismatched native libraries: ${abi}`);
  }
  const target = abi === 'arm64-v8a' ? 'android-arm64' : 'android-x64';
  const resourceRoot = new URL('../src-tauri/resources/sub-store/', import.meta.url);
  const sourceManifest = readFileSync(new URL(`${target}/manifest.json`, resourceRoot));
  const manifestEntry = `assets/ppclash-cloud/${target}/manifest.json`;
  if (!entries.includes(manifestEntry) || !execFileSync('unzip', ['-p', apk, manifestEntry]).equals(sourceManifest)) throw new Error(`APK Sub-Store manifest is stale: ${abi}`);
  const manifest = JSON.parse(sourceManifest);
  const expected = ['sub-store.bundle.cjs', 'service-bootstrap.cjs', 'build-provenance.json', 'runtime-manifest.json', `${target}/node`, `${target}/LICENSE`];
  if (manifest.target !== target || manifest.nodeVersion !== '24.18.0' || manifest.engineVersion !== '2.44.16' || manifest.files?.length !== 6 || expected.some(path => manifest.files.filter(row => row.path === path).length !== 1)) throw new Error(`Invalid APK runtime manifest: ${abi}`);
  for (const row of manifest.files) {
    const name = row.path === `${target}/node` ? `lib/${abi}/libppclash_node.so` : `assets/ppclash-cloud/${row.path}`;
    if (!entries.includes(name)) throw new Error(`APK runtime resource missing: ${name}`);
    const bytes = execFileSync('unzip', ['-p', apk, name], { maxBuffer: 256 * 1024 * 1024 });
    if (bytes.length !== row.bytes || digest(bytes) !== row.sha256) throw new Error(`APK runtime resource changed: ${name}`);
  }
  verifyElf(new URL(`${target}/node`, resourceRoot), target);
  for (const name of libraries) {
    const elf = execFileSync('unzip', ['-p', apk, name], { maxBuffer: 256 * 1024 * 1024 });
    if (elf.subarray(0, 4).toString('hex') !== '7f454c46' || elf[4] !== 2 || elf[5] !== 1
        || elf.readUInt16LE(18) !== (abi === 'arm64-v8a' ? 183 : 62)) {
      throw new Error(`Native library does not match ${abi}: ${name}`);
    }
    if (name.endsWith('/libgojni.so') && !elf.includes(geodata)) {
      throw new Error(`APK core does not contain the verified offline geodata: ${abi}`);
    }
  }
  if (entries.some(name => /(?:kernel\.zip|\.keystore|\.jks)$/.test(name))) throw new Error('APK contains a desktop kernel or signing material');
  const badging = run(join(buildTools, 'aapt2'), ['dump', 'badging', apk]);
  if (!badging.includes("name='com.ppclash.app'") || !badging.includes(`versionName='${version}'`)) throw new Error('APK identity/version mismatch');
  if (!/^(?:minSdkVersion|sdkVersion):'24'$/m.test(badging) || !/^targetSdkVersion:'36'$/m.test(badging)) throw new Error('APK SDK configuration mismatch');
  if (mode === 'release' && badging.includes('application-debuggable')) throw new Error('Release APK is debuggable');
  const signature = run(join(buildTools, 'apksigner'), ['verify', '--verbose', '--print-certs', apk]);
  if (mode === 'release' && /certificate DN:.*CN=Android Debug/i.test(signature)) throw new Error('Release APK uses the Android debug key');
  const fingerprint = signature.match(/Signer #1 certificate SHA-256 digest: ([a-fA-F0-9]+)/)?.[1].toLowerCase();
  if (!fingerprint || (certificate && certificate !== fingerprint) || (expectedCertificate && fingerprint !== expectedCertificate)) {
    throw new Error('APK signing certificate mismatch');
  }
  certificate = fingerprint;
  run(join(buildTools, 'zipalign'), ['-c', '-P', '16', '4', apk]);
  console.log(`Validated Android ${abi} ${version} (${(statSync(apk).size / 1024 / 1024).toFixed(1)} MiB)`);
}
if (mode === 'release') {
  const aab = join(directory, `ppclash-android-v${version}.aab`);
  const entries = run('unzip', ['-Z1', aab]).split('\n');
  for (const abi of ['arm64-v8a', 'x86_64']) for (const library of ['libppclash_lib.so', 'libgojni.so', 'libppclash_node.so']) {
    if (!entries.includes(`base/lib/${abi}/${library}`)) throw new Error(`Bundle is missing ${abi}/${library}`);
    if (library === 'libgojni.so') {
      const core = execFileSync('unzip', ['-p', aab, `base/lib/${abi}/${library}`], { maxBuffer: 256 * 1024 * 1024 });
      if (!core.includes(geodata)) throw new Error(`Bundle core does not contain the verified offline geodata: ${abi}`);
    }
    if (library === 'libppclash_node.so') {
      const target = abi === 'arm64-v8a' ? 'android-arm64' : 'android-x64';
      const runtime = new URL('../src-tauri/resources/sub-store/', import.meta.url);
      const manifestBytes = readFileSync(new URL(`${target}/manifest.json`, runtime));
      const manifest = JSON.parse(manifestBytes);
      const node = execFileSync('unzip', ['-p', aab, `base/lib/${abi}/${library}`], { maxBuffer: 256 * 1024 * 1024 });
      if (digest(node) !== manifest.files.find(row => row.path === `${target}/node`)?.sha256) throw new Error(`Bundle Node runtime changed: ${abi}`);
      const bundledManifest = execFileSync('unzip', ['-p', aab, `base/assets/ppclash-cloud/${target}/manifest.json`]);
      if (!bundledManifest.equals(manifestBytes)) throw new Error(`Bundle runtime manifest is stale: ${abi}`);
      for (const row of manifest.files.filter(row => row.path !== `${target}/node`)) {
        const bytes = execFileSync('unzip', ['-p', aab, `base/assets/ppclash-cloud/${row.path}`], { maxBuffer: 256 * 1024 * 1024 });
        if (bytes.length !== row.bytes || digest(bytes) !== row.sha256) throw new Error(`Bundle resource changed: ${row.path}`);
      }
    }
  }
  const signature = run(join(process.env.JAVA_HOME, 'bin/jarsigner'), ['-J-Duser.language=en', '-J-Duser.country=US', '-verify', aab]);
  if (!signature.includes('jar verified.')) throw new Error('Bundle signature verification failed');
  const bundleCertificate = run(join(process.env.JAVA_HOME, 'bin/keytool'), ['-J-Duser.language=en', '-printcert', '-jarfile', aab]);
  const fingerprint = bundleCertificate.match(/SHA256: ([A-Fa-f0-9:]+)/)?.[1].replaceAll(':', '').toLowerCase();
  if (fingerprint !== certificate) throw new Error('Bundle signing certificate does not match the APKs');
  console.log(`Validated Android App Bundle ${version} (${(statSync(aab).size / 1024 / 1024).toFixed(1)} MiB)`);
}
const allowed = new Set(['SHA256SUMS', ...['arm64-v8a', 'x86_64'].map(abi => `ppclash-android-${abi}-v${version}.apk`)]);
if (mode === 'release') allowed.add(`ppclash-android-v${version}.aab`);
if (readdirSync(directory).some(name => !allowed.has(name))) throw new Error('Android output contains stale or unexpected artifacts');
