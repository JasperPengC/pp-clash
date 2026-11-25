// Only the native facade can enter the complete official service.
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const token = process.env.PPCLASH_SUB_STORE_TOKEN;
const prefix = process.env.SUB_STORE_FRONTEND_BACKEND_PATH;
if (!token || !prefix || !/^\/[a-f0-9]{32}$/.test(prefix)) throw new Error('Missing native service session');
const expected = Buffer.from(`Bearer ${token}`);
const servers = new Set();
const requests = new Set();
let draining = false;
async function shutdown(res) {
  if (draining) { res.writeHead(409); res.end('Sub-Store 正在等待任务结束'); return; }
  draining = true;
  const lifecycle = globalThis[Symbol.for('ppclash.sub-store.lifecycle')];
  lifecycle?.pause();
  const deadline = performance.now() + 5000;
  while ((requests.size || (lifecycle && !lifecycle.idle())) && performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (requests.size || (lifecycle && !lifecycle.idle())) {
    draining = false;
    lifecycle?.resume();
    res.writeHead(409); res.end('Sub-Store 仍有任务执行，未停止或生成快照，请稍后重试');
    return;
  }
  res.writeHead(200, { 'Connection': 'close' }); res.end('Stopping');
  Promise.all([...servers].map(server => new Promise(resolve => server.close(resolve)))).then(() => process.exit(0));
}
const nativePort = Number(process.env.SUB_STORE_BACKEND_API_PORT);
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, ...args) {
  // Only a pre-listen collision on this private endpoint is safe to classify for a new-port retry.
  if (event === 'error' && servers.size === 0 && args[0]?.code === 'EADDRINUSE' &&
      args[0]?.syscall === 'listen' && args[0]?.address === '127.0.0.1' && args[0]?.port === nativePort) {
    // A script may exit with the same code before readiness. Prove this launch hit the binding branch.
    require('node:fs').writeFileSync(process.env.PPCLASH_SUB_STORE_STARTUP_STATUS, token, { flag: 'wx', mode: 0o600 });
    process.exit(98);
  }
  if (event === 'listening') servers.add(this);
  if (event === 'request') {
    const [req, res] = args;
    const actual = Buffer.from(req.headers.authorization || '');
    if (req.headers.origin || req.headers['sec-fetch-site'] ||
        !req.url.startsWith(`${prefix}/`) || actual.length !== expected.length ||
        !crypto.timingSafeEqual(actual, expected)) {
      res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Native Sub-Store session required');
      return true;
    }
    if (req.url === `${prefix}/__ppclash_shutdown` && req.method === 'POST') {
      shutdown(res).catch(() => { draining = false; globalThis[Symbol.for('ppclash.sub-store.lifecycle')]?.resume(); res.writeHead(500); res.end('Sub-Store 停止失败，请重试'); });
      return true;
    }
    if (draining) { res.writeHead(503); res.end('Sub-Store 正在等待任务结束'); return true; }
    // A disconnected HTTP client does not cancel its handler. Track through res.end, not socket close.
    requests.add(res);
    const end = res.end;
    res.end = function (...values) { requests.delete(res); return end.apply(this, values); };
  }
  return emit.call(this, event, ...args);
};
// Detect parent death even when the application crashed without running Drop.
const parent = Number(process.env.PPCLASH_SUB_STORE_PARENT_PID);
if (!Number.isSafeInteger(parent) || parent <= 1) throw new Error('Missing service parent');
// Script code may block the main event loop; the watcher must run independently.
const { Worker } = require('node:worker_threads');
const watcher = new Worker(`
  const { workerData } = require('node:worker_threads');
  setInterval(() => {
    let missing = process.ppid !== workerData.parent;
    try { process.kill(workerData.parent, 0); } catch { missing = true; }
    if (missing) process.kill(process.pid, 'SIGKILL');
  }, 1000);
`, { eval: true, workerData: { parent } });
watcher.unref();
require(path.join(__dirname, 'sub-store.bundle.cjs'));
