// 在隔离数据目录检查完整服务 API 和相关上游回归用例。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const runtime = path.join(root, '.cache/cloud-tools-20261121/runtime');
const provenance = JSON.parse(fs.readFileSync(path.join(runtime, 'build-provenance.json')));
const patchDigest = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, provenance.patch))).digest('hex');
assert.equal(patchDigest, provenance.patchSha256, 'Source patch changed; rebuild the runtime before verification');
const digest = crypto.createHash('sha256').update(fs.readFileSync(provenance.output.bundle.path)).digest('hex');
assert.equal(digest, provenance.output.bundle.sha256, 'Bundle does not match build provenance');
const testData = fs.mkdtempSync(path.join(runtime, 'upstream-tests-'));
const results = [];
function run(name, args, cwd, extraEnv, logName) {
  const log = path.join(runtime, logName);
  const fd = fs.openSync(log, 'w');
  try {
    const result = spawnSync(process.execPath, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', fd, fd],
    });
    results.push({ name, status: result.status === 0 ? 'passed' : 'failed', exitCode: result.status, error: result.error?.message, log, command: [process.execPath, ...args] });
    console.log(`${results.at(-1).status.toUpperCase()} ${name}: ${log}`);
  } finally {
    fs.closeSync(fd);
  }
}
run('complete service API', [path.join(__dirname, 'probe.cjs')], root, {
  SUB_STORE_TEST_BUNDLE: provenance.output.bundle.path,
  SUB_STORE_TEST_REPORT: path.join(runtime, 'acceptance-strict.json'),
}, 'strict-probe.log');
run('processor diagnostic API', [path.join(__dirname, 'diagnostics-probe.cjs')], root, {
  SUB_STORE_TEST_BUNDLE: provenance.output.bundle.path,
}, 'diagnostics-probe.log');
run('processor trace API', [path.join(__dirname, 'trace-probe.cjs')], root, {
  SUB_STORE_TEST_BUNDLE: provenance.output.bundle.path,
}, 'trace-probe.log');
run('upstream targeted regressions', [
  'node_modules/mocha/bin/mocha.js',
  'src/test/proxy-processors/process-context.spec.js',
  'src/test/restful/sync.spec.js',
  'src/test/restful/mihomo-config.spec.js',
  '--require', '@babel/register',
], path.join(provenance.source, 'backend'), {
  SUB_STORE_DATA_BASE_PATH: testData,
  SUB_STORE_FRONTEND_BACKEND_PATH: '/',
  BABEL_CACHE_PATH: path.join(testData, 'babel-cache.json'),
}, 'upstream-tests.log');
const report = { runtime: process.version, bundleSha256: digest, status: results.every(r => r.status === 'passed') ? 'passed' : 'failed', results, testData };
fs.writeFileSync(path.join(runtime, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`);
if (report.status !== 'passed') process.exitCode = 1;
