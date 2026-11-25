// The engine artifact is shared by every target, including Android.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const upstream = require('./upstream-lock.json');
const sharedFiles = ['sub-store.bundle.cjs', 'service-bootstrap.cjs', 'build-provenance.json', 'runtime-manifest.json'];
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function prepareSharedEngine(root) {
  const engine = path.join(root, '.cache/cloud-tools-20261121/runtime');
  const output = path.join(root, 'src-tauri/resources/sub-store');
  const provenance = JSON.parse(fs.readFileSync(path.join(engine, 'build-provenance.json')));
  for (const key of Object.keys(upstream)) assert.equal(provenance[key], upstream[key], `Engine provenance mismatch: ${key}`);
  assert.equal(provenance.patch, 'scripts/sub-store/strict-errors.patch', 'Unexpected engine patch path');
  assert.equal(sha(path.join(root, provenance.patch)), provenance.patchSha256, 'Patch changed: rebuild the strict engine first');
  assert.equal(sha(path.join(engine, 'sub-store.strict.bundle.cjs')), provenance.output.bundle.sha256, 'Engine bundle checksum mismatch');
  assert.equal(sha(path.join(engine, 'runtime-manifest-strict.json')), provenance.output.manifest.sha256, 'Engine manifest checksum mismatch');
  assert.ok(fs.statSync(path.join(output, 'service-bootstrap.cjs')).isFile(), 'Missing service bootstrap source');
  for (const [source, destination] of [
    ['sub-store.strict.bundle.cjs', 'sub-store.bundle.cjs'],
    ['build-provenance.json', 'build-provenance.json'],
    ['runtime-manifest-strict.json', 'runtime-manifest.json'],
  ]) fs.copyFileSync(path.join(engine, source), path.join(output, destination));
  return sharedFiles;
}

module.exports = { prepareSharedEngine };
