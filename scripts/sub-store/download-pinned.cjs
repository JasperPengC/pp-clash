'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// Each CI job owns its cache. Preserve partial bytes across retries and reruns;
// a completed archive is usable only after checking the pinned digest.
function downloadPinned(url, archive, expected) {
  if (fs.existsSync(archive)) {
    assert.equal(sha(archive), expected, 'Cached archive checksum mismatch');
    return;
  }
  const partial = `${archive}.partial`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = spawnSync('curl', ['--fail', '--location', '--silent', '--show-error',
      '--connect-timeout', '30', '--max-time', '600', '--continue-at', '-', url,
      '--output', partial, '--write-out', '%{http_code}'], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.stdout === '416') {
      fs.rmSync(partial, { force: true });
      continue;
    }
    if (result.status === 0) {
      if (sha(partial) !== expected) {
        fs.rmSync(partial, { force: true });
        throw new Error('Downloaded archive checksum mismatch');
      }
      fs.renameSync(partial, archive);
      return;
    }
    // Some mirrors do not support ranges; retry once from the beginning.
    if (result.status === 33) fs.rmSync(partial, { force: true });
    console.error(`Archive download interrupted (curl ${result.status}); attempt ${attempt + 1}/3`);
  }
  throw new Error(`Archive download failed; partial bytes retained at ${partial}`);
}

module.exports = { downloadPinned };
