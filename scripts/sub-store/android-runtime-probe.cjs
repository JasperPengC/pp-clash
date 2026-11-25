// Run this probe with the APK-installed nativeLibraryDir/libppclash_node.so.
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const tls = require('node:tls');
const { Worker } = require('node:worker_threads');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
// The probe runs on Android without an openssl executable. Encode only the
// X.509 fields needed by this one-use localhost identity, using Node crypto
// for the keypair and ECDSA signature; no private material is stored on disk.
function createProbeCredentials() {
  const der = (tag, ...parts) => {
    const content = Buffer.concat(parts);
    let length = content.length;
    const size = [];
    do { size.unshift(length & 0xff); length = Math.floor(length / 256); } while (length);
    const header = content.length < 128 ? [content.length] : [0x80 | size.length, ...size];
    return Buffer.concat([Buffer.from([tag, ...header]), content]);
  };
  const sequence = (...parts) => der(0x30, ...parts);
  const signatureAlgorithm = sequence(Buffer.from('06082a8648ce3d040302', 'hex')); // ecdsa-with-SHA256
  const name = sequence(der(0x31, sequence(Buffer.from('0603550403', 'hex'), der(0x0c, Buffer.from('localhost')))));
  const time = (date) => der(0x18, Buffer.from(date.toISOString().replace(/[-:T]/g, '').replace(/\.\d{3}Z$/, 'Z')));
  const now = Date.now();
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const serial = crypto.randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 1;
  const subjectAltName = sequence(Buffer.from('0603551d11', 'hex'),
    der(0x04, sequence(der(0x82, Buffer.from('localhost')))));
  const body = sequence(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, serial),
    signatureAlgorithm, name,
    sequence(time(new Date(now - 60000)), time(new Date(now + 24 * 60 * 60 * 1000))),
    name, publicKey.export({ type: 'spki', format: 'der' }), der(0xa3, sequence(subjectAltName)));
  const certificate = sequence(body, signatureAlgorithm,
    der(0x03, Buffer.from([0]), crypto.sign('sha256', body, privateKey)));
  const pem = certificate.toString('base64').match(/.{1,64}/g).join('\n');
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: `-----BEGIN CERTIFICATE-----\n${pem}\n-----END CERTIFICATE-----\n`,
  };
}

async function main() {
  assert.equal(process.versions.node, '24.18.0');
  if (!process.argv.includes('--allow-host')) assert.equal(process.platform, 'android');
  const target = process.argv.find((arg) => /^android-(arm64|x64)$/.test(arg));
  if (target) assert.equal(process.arch, target.slice(8));
  assert.equal(crypto.createHash('sha256').update('ppclash').digest('hex').length, 64);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE probe (value TEXT); INSERT INTO probe VALUES ('sqlite-ok');");
    assert.equal(db.prepare('SELECT value FROM probe').get().value, 'sqlite-ok');
  } finally { db.close(); }
  const worker = new Worker('require("node:worker_threads").parentPort.postMessage({ version: process.versions.node, arch: process.arch });', { eval: true });
  const workerResult = await new Promise((resolve, reject) => {
    worker.once('message', resolve); worker.once('error', reject);
    worker.once('exit', (code) => { if (code) reject(new Error(`Worker exited ${code}`)); });
  });
  assert.deepEqual(workerResult, { version: process.versions.node, arch: process.arch });
  await worker.terminate();
  const child = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({version:process.versions.node,arch:process.arch,platform:process.platform}))'], { timeout: 10000 });
  assert.deepEqual(JSON.parse(child.stdout), { version: process.versions.node, arch: process.arch, platform: process.platform });
  const identity = createProbeCredentials();
  const server = tls.createServer({ ...identity, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' }, (socket) => socket.end('tls-ok'));
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const tlsResult = await new Promise((resolve, reject) => {
      const client = tls.connect({ host: '127.0.0.1', port: server.address().port,
        ca: identity.cert, servername: 'localhost', rejectUnauthorized: true,
        minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' });
      let data = ''; client.setEncoding('utf8');
      client.on('data', (chunk) => { data += chunk; });
      client.once('error', reject);
      client.once('end', () => resolve({ data, protocol: client.getProtocol(), authorized: client.authorized }));
    });
    assert.equal(tlsResult.data, 'tls-ok');
    assert.equal(tlsResult.protocol, 'TLSv1.3');
    assert.equal(tlsResult.authorized, true);
    const digest = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(process.execPath)) digest.update(chunk);
    console.log(JSON.stringify({ runtimeSha256: digest.digest('hex'), nodeVersion: process.versions.node, platform: process.platform, arch: process.arch, execPath: process.execPath, worker_threads: 'ok', child_process: 'ok', sqlite: 'ok', tls: tlsResult.protocol }));
  } finally { await new Promise((resolve) => server.close(resolve)); }
}
module.exports = { createProbeCredentials };
if (require.main === module) {
  const timeout = setTimeout(() => { console.error('Android runtime probe timed out'); process.exit(1); }, 20000);
  main().then(() => clearTimeout(timeout)).catch((error) => { clearTimeout(timeout); console.error(error.stack); process.exitCode = 1; });
}
