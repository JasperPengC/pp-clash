// 真实引擎的步骤定位回归；仅使用回环端口及独立合成数据目录。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: pause } = require('node:timers/promises');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.cache/processor-diagnostics-20261123');
fs.mkdirSync(output, { recursive: true });
const data = fs.mkdtempSync(path.join(output, 'engine-'));
const bundle = path.resolve(process.env.SUB_STORE_TEST_BUNDLE || path.join(root, '.cache/cloud-tools-20261121/runtime/sub-store.strict.bundle.cjs'));
const report = { bundle, data, checks: [], failures: [] };
const log = fs.createWriteStream(path.join(data, 'server.log'));
let child, port;
async function start() {
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  child = spawn(process.execPath, [bundle], { cwd: data, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'en_US.UTF-8', SUB_STORE_DATA_BASE_PATH: data, SUB_STORE_BACKEND_API_HOST: '127.0.0.1', SUB_STORE_BACKEND_API_PORT: String(port), SUB_STORE_FRONTEND_BACKEND_PATH: '/' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  for (let at = 0; at < 80; at++) {
    if (child.exitCode !== null) throw new Error(`Engine exited: ${child.exitCode}`);
    try { const result = await fetch(`http://127.0.0.1:${port}/api/subs`, { signal: AbortSignal.timeout(500) }); if (result.ok) return; } catch {}
    await pause(100);
  }
  throw new Error('Engine readiness timeout');
}
async function api(route, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  return { status: response.status, value: await response.json() };
}
async function success(route, body, method) {
  const result = await api(route, body, method); assert.equal(result.value.status, 'success', JSON.stringify(result)); return result.value.data;
}
async function state() {
  const values = {}; for (const route of ['/api/subs', '/api/collections', '/api/wholeFiles', '/api/settings']) values[route] = await success(route); return values;
}
async function check(name, action) {
  try { await action(); report.checks.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, status: 'failed', error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
}
async function failure(route, body, expected, reason) {
  const before = await state(); const result = await api(route, body);
  report.failures.push({ route, result });
  assert.deepEqual(await state(), before, '预览失败不得改写已存状态');
  assert.ok(result.status >= 400); assert.equal(result.value.status, 'failed');
  assert.match(result.value.error.details, new RegExp(reason));
  assert.deepEqual(result.value.error.processor, expected);
  return result;
}
const step = (content, extra = {}) => ({ type: 'Script Operator', args: { mode: 'script', content }, ...extra });
const node = { name: 'HK synthetic', type: 'trojan', server: 'example.invalid', port: 443, password: 'synthetic-only' };
const source = { name: 'diagnostic-source', source: 'local', content: JSON.stringify({ proxies: [node] }), process: [] };
const broken = step('function operator() { throw new Error("diagnostic-failure"); }', { customName: '第二段脚本' });
const scope = (kind, name, index, type = 'Script Operator', customName) => ({ index, type, ...(customName ? { name: customName } : {}), scope: { kind, name } });
async function main() {
  await start(); await success('/api/subs', source);
  await check('禁用步骤仍计入原始下标，同类型失败定位到第二段脚本', () => failure('/api/preview/sub', { ...source, process: [{ type: 'Missing', disabled: true }, step('function operator(proxies) { return proxies; }'), broken] }, scope('sub', source.name, 2, 'Script Operator', '第二段脚本'), 'diagnostic-failure'));
  await check('未知启用处理器保留类型和步骤', () => failure('/api/preview/sub', { ...source, process: [{ type: 'Missing Diagnostic Operator' }] }, scope('sub', source.name, 0, 'Missing Diagnostic Operator'), 'Missing Diagnostic Operator'));
  await check('脚本加载失败定位当前步骤', () => failure('/api/preview/sub', { ...source, process: [step('', { args: { mode: 'link', content: '/api/file/not-present-diagnostic' } })] }, scope('sub', source.name, 0), 'not-present-diagnostic'));
  const badSource = { ...source, name: 'bad-child', process: [broken] }; await success('/api/subs', badSource);
  const collection = { name: 'diagnostic-collection', subscriptions: [source.name], process: [] }; await success('/api/collections', collection);
  await check('组合内来源失败指向真实来源', () => failure('/api/preview/collection', { ...collection, subscriptions: [badSource.name] }, scope('sub', badSource.name, 0, 'Script Operator', '第二段脚本'), 'diagnostic-failure'));
  await check('组合自身处理器失败指向组合', () => failure('/api/preview/collection', { ...collection, process: [broken] }, scope('collection', collection.name, 0, 'Script Operator', '第二段脚本'), 'diagnostic-failure'));
  const reservedSource = { ...source, name: '_collection', process: [broken] }; await success('/api/subs', reservedSource);
  await check('合法来源名_collection在组合中仍指向来源', () => failure('/api/preview/collection', { ...collection, subscriptions: [source.name, reservedSource.name] }, scope('sub', reservedSource.name, 0, 'Script Operator', '第二段脚本'), 'diagnostic-failure'));
  await check('来源名_collection及未知subscriptions字段不会伪装成组合', () => failure('/api/preview/sub', { ...reservedSource, subscriptions: ['advanced-preserved-field'] }, scope('sub', reservedSource.name, 0, 'Script Operator', '第二段脚本'), 'diagnostic-failure'));
  const anotherSource = { ...source, name: 'another-diagnostic-source' }; await success('/api/subs', anotherSource);
  await check('多来源组合自身失败仍指向组合', () => failure('/api/preview/collection', { ...collection, subscriptions: [source.name, anotherSource.name], process: [broken] }, scope('collection', collection.name, 0, 'Script Operator', '第二段脚本'), 'diagnostic-failure'));
  const file = { name: 'diagnostic-file', source: 'local', content: 'synthetic content', process: [] }; await success('/api/files', file);
  await check('文件自身处理器失败指向文件', () => failure('/api/preview/file', { ...file, process: [broken] }, scope('file', file.name, 0, 'Script Operator', '第二段脚本'), 'diagnostic-failure'));
  await check('文件跳过响应转换后仍使用原始处理器下标', () => failure('/api/preview/file', { ...file, process: [{ type: 'Response Transformer', args: { mode: 'script', content: 'throw new Error("response-must-be-skipped")' } }, broken] }, scope('file', file.name, 1, 'Script Operator', '第二段脚本'), 'diagnostic-failure'));
  const reservedCollection = { ...collection, name: 'reserved-child-collection', subscriptions: [reservedSource.name] }; await success('/api/collections', reservedCollection);
  await check('Mihomo文件经组合引用_collection来源时定位不混淆', () => failure('/api/preview/file', { name: 'reserved-mihomo', type: 'mihomoConfig', sourceType: 'collection', sourceName: reservedCollection.name, process: [] }, scope('sub', reservedSource.name, 0, 'Script Operator', '第二段脚本'), 'diagnostic-failure'));
  const failedCollection = { ...collection, name: 'failed-file-collection', process: [broken] }; await success('/api/collections', failedCollection);
  await check('Mihomo文件引用组合自身处理器失败指向组合', () => failure('/api/preview/file', { name: 'collection-mihomo', type: 'mihomoConfig', sourceType: 'collection', sourceName: failedCollection.name, process: [] }, scope('collection', failedCollection.name, 0, 'Script Operator', '第二段脚本'), 'diagnostic-failure'));
  await check('Mihomo文件来源失败指向子来源', () => failure('/api/preview/file', { name: 'mihomo-diagnostic', type: 'mihomoConfig', sourceType: 'subscription', sourceName: badSource.name, process: [] }, scope('sub', badSource.name, 0, 'Script Operator', '第二段脚本'), 'diagnostic-failure'));
  await check('修改上下文来源名称不污染失败定位', () => failure('/api/preview/sub', { ...source, process: [step('function operator(proxies, target, context) { context.source["diagnostic-source"].name = "WRONG"; throw new Error("identity-failure"); }')] }, scope('sub', source.name, 0), 'identity-failure'));
  await check('诊断不重放有副作用的脚本', async () => {
    await failure('/api/preview/sub', { ...source, process: [step('function operator() { globalThis.__diagnosticCount = (globalThis.__diagnosticCount || 0) + 1; throw new Error("count-failure"); }')] }, scope('sub', source.name, 0), 'count-failure');
    const result = await success('/api/preview/sub', { ...source, process: [step('function operator(proxies) { proxies[0].name = "count-" + globalThis.__diagnosticCount; return proxies; }')] });
    assert.equal(result.processed[0].name, 'count-1');
  });
  await check('超长原因保持JSON完整及定位契约', async () => {
    const result = await failure('/api/preview/sub', { ...source, process: [step('function operator() { throw new Error("long-failure " + "\\u0000".repeat(30000)); }')] }, scope('sub', source.name, 0), 'long-failure');
    assert.ok(JSON.stringify(result.value).length < 16000, '错误经过原生长度限制后仍须是完整JSON');
  });
  await check('修复后预览成功，禁用错误步骤不执行，成功输出保持一致', async () => {
    const result = await success('/api/preview/sub', { ...source, process: [{ ...broken, disabled: true }, step('function operator(proxies) { return proxies.map(proxy => ({ ...proxy, name: "fixed " + proxy.name })); }')] });
    assert.equal(result.processed[0].name, 'fixed HK synthetic'); assert.equal(result.processed[0].server, node.server); assert.equal(result.original[0].name, node.name);
    assert.equal(result.processor, undefined); assert.equal((await success(`/api/sub/${source.name}`)).process.length, 0);
  });
  await check('非处理器内容错误不伪造步骤', async () => {
    const result = await api('/api/preview/file', { name: 'missing-collection', type: 'mihomoConfig', sourceType: 'collection', sourceName: 'not-present', process: [] });
    assert.equal(result.value.status, 'failed'); assert.equal(result.value.error.processor, undefined);
  });
  report.status = report.checks.every(item => item.status === 'passed') ? 'passed' : 'failed';
  if (report.status !== 'passed') process.exitCode = 1;
}
main().catch(error => { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }).finally(async () => {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 3000); await exited; clearTimeout(timer); }
  log.end(); report.processStopped = !child || child.exitCode !== null || child.signalCode !== null;
  fs.writeFileSync(path.join(data, 'acceptance.json'), JSON.stringify(report, null, 2));
  console.log(`Report: ${path.join(data, 'acceptance.json')}`);
});
