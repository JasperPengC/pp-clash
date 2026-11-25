// 真实预览链路回归：只使用回环服务和独立合成状态。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: pause } = require('node:timers/promises');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.cache/processor-trace-20261123');
fs.mkdirSync(output, { recursive: true });
const data = fs.mkdtempSync(path.join(output, 'engine-'));
const bundle = path.resolve(process.env.SUB_STORE_TEST_BUNDLE || path.join(root, '.cache/cloud-tools-20261121/runtime/sub-store.strict.bundle.cjs'));
const report = { bundle, data, checks: [], traces: {} };
const log = fs.createWriteStream(path.join(data, 'server.log'));
let child, port, fixture;
async function start() {
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  child = spawn(process.execPath, [bundle], { cwd: data, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'en_US.UTF-8', SUB_STORE_DATA_BASE_PATH: data, SUB_STORE_BACKEND_API_HOST: '127.0.0.1', SUB_STORE_BACKEND_API_PORT: String(port), SUB_STORE_FRONTEND_BACKEND_PATH: '/' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  for (let at = 0; at < 100; at++) {
    if (child.exitCode !== null) throw new Error(`Engine exited: ${child.exitCode}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/api/subs`, { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
    await pause(100);
  }
  throw new Error('Engine readiness timeout');
}
async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 3000); await exited; clearTimeout(timer);
  }
}
async function api(route, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const text = await response.text();
  return { status: response.status, text, value: JSON.parse(text) };
}
async function success(route, body, method) {
  const result = await api(route, body, method); assert.equal(result.value.status, 'success', result.text); return result.value.data;
}
async function state() {
  const values = {}; for (const route of ['/api/subs', '/api/collections', '/api/wholeFiles', '/api/settings']) values[route] = await success(route); return values;
}
async function check(name, action) {
  try { await action(); report.checks.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, status: 'failed', error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
}
function trace(value, key) {
  const result = value.trace; assert.ok(result, '预览响应应包含 trace');
  assert.deepEqual(Object.keys(result).sort(), ['chains', 'truncated', 'version']); assert.equal(result.version, 1);
  assert.ok(Array.isArray(result.chains)); assert.ok(result.chains.length <= 200); assert.equal(typeof result.truncated, 'boolean');
  assert.ok(JSON.stringify(result).length <= 8000, 'trace JSON 超出 8000 字符');
  assert.ok(result.chains.reduce((sum, chain) => sum + chain.steps.length, 0) <= 200, 'trace 超出 200 步');
  for (const chain of result.chains) {
    assert.deepEqual(Object.keys(chain).sort(), ['scope', 'steps']); assert.ok(['sub', 'collection', 'file'].includes(chain.scope.kind)); assert.equal(typeof chain.scope.name, 'string');
    let previousIndex = -1;
    for (const step of chain.steps) {
      assert.ok(step.index > previousIndex, '链内原始序号必须严格递增'); previousIndex = step.index;
      assert.ok(Number.isInteger(step.index) && step.index >= 0); assert.equal(typeof step.type, 'string');
      assert.ok(['success', 'failed', 'skipped', 'not-run'].includes(step.status));
      assert.ok(Object.keys(step).every(key => ['index','type','name','status','durationMs','inputCount','outputCount','skipReason'].includes(key)));
      if (['success', 'failed'].includes(step.status)) assert.ok(Number.isFinite(step.durationMs) && step.durationMs >= 0);
      else assert.equal(step.durationMs, undefined);
      if (step.status === 'failed') assert.equal(step.outputCount, undefined);
      if (step.status === 'not-run') { assert.equal(step.inputCount, undefined); assert.equal(step.outputCount, undefined); }
      if (step.status === 'skipped') assert.ok(['disabled', 'context', 'response-transformer'].includes(step.skipReason));
      else assert.equal(step.skipReason, undefined);
    }
  }
  if (key) report.traces[key] = result; return result;
}
function chain(result, kind, name) { const found = result.chains.find(item => item.scope.kind === kind && item.scope.name === name); assert.ok(found, `缺少处理链 ${kind}/${name}`); return found; }
const script = (content, extra = {}) => ({ type: 'Script Operator', args: { mode: 'script', content }, ...extra });
const identity = script('function operator(proxies) { return proxies; }');
const broken = script('function operator() { throw new Error("trace-failure"); }', { customName: '失败步骤' });
const node = { name: 'HK synthetic', type: 'trojan', server: 'example.invalid', port: 443, password: 'synthetic-only' };
const source = { name: 'trace-source', source: 'local', content: JSON.stringify({ proxies: [node] }), process: [] };
const file = { name: 'trace-file', source: 'local', content: 'synthetic content', process: [] };
async function preview(body, kind = 'sub') { return success(`/api/preview/${kind}`, body); }
async function failure(body, kind = 'sub') {
  const result = await api(`/api/preview/${kind}`, body); assert.ok(result.status >= 400); assert.equal(result.value.status, 'failed');
  assert.ok(result.text.length < 16000, '原生错误通道必须保留完整 JSON'); return result.value.error;
}
async function main() {
  await start(); await success('/api/subs', source); await success('/api/files', file);
  await check('成功链包含原始序号、三种跳过原因及非负耗时', async () => {
    const result = await preview({ ...source, process: [
      { ...broken, disabled: true },
      script('function operator(proxies, target, context) { context.process = { type: "disable", customNames: ["被上下文跳过"] }; return proxies; }'),
      { ...broken, customName: '被上下文跳过' },
      { type: 'Response Transformer', args: { content: 'throw new Error("must not run")' } }, identity,
    ] });
    const steps = chain(trace(result, 'success'), 'sub', source.name).steps;
    assert.deepEqual(steps.map(s => [s.index, s.status, s.skipReason]), [[0,'skipped','disabled'], [1,'success',undefined], [2,'skipped','context'], [3,'skipped','response-transformer'], [4,'success',undefined]]);
    assert.deepEqual([steps[1].inputCount,steps[1].outputCount,steps[4].inputCount,steps[4].outputCount], [1,1,1,1]);
    assert.equal(result.processed[0].name, node.name); assert.deepEqual(result.original[0], result.processed[0]);
  });
  await check('0 节点不会被省略，成功输出数量反映真实结果', async () => {
    const steps = trace(await preview({ ...source, process: [script('function operator() { return []; }'), identity] })).chains[0].steps;
    assert.deepEqual(steps.map(s => [s.inputCount,s.outputCount]), [[1,0],[0,0]]);
  });
  await check('失败保留此前状态、失败步骤、后续 not-run 且不会执行后续副作用', async () => {
    const error = await failure({ ...source, process: [identity, broken, script('function operator(proxies) { globalThis.__traceUnexpected = true; return proxies; }'), { ...broken, disabled: true }] });
    const steps = trace(error, 'failure').chains[0].steps;
    assert.deepEqual(steps.map(s => s.status), ['success','failed','not-run','not-run']); assert.equal(steps[1].inputCount, 1); assert.equal(error.processor.index, 1);
    const result = await preview({ ...source, process: [script('function operator(proxies) { proxies[0].name = String(globalThis.__traceUnexpected); return proxies; }')] }); assert.equal(result.processed[0].name, 'undefined');
  });
  await check('未知处理器与脚本加载失败也有 failed 及 not-run', async () => {
    for (const item of [{ type: 'Unknown Trace Operator' }, script('', { args: { mode: 'link', content: '/api/file/trace-missing-file' } })]) {
      const error = await failure({ ...source, process: [item, identity] }); assert.deepEqual(trace(error).chains[0].steps.map(s => s.status), ['failed','not-run']);
    }
  });
  await check('普通文件不把字符数或文件数伪造成节点数', async () => {
    const result = await preview({ ...file, process: [script('$content += " changed";')] }, 'file');
    assert.equal(result.original, file.content); assert.equal(result.processed, 'synthetic content changed');
    const step = trace(result).chains[0].steps[0]; assert.equal(step.inputCount, undefined); assert.equal(step.outputCount, undefined);
    const error = await failure({ ...file, process: [broken, identity] }, 'file'); assert.equal(trace(error).chains[0].steps[0].inputCount, undefined);
  });
  await check('无处理器的已进入链允许空 steps', async () => {
    for (const [body, kind] of [[source,'sub'],[file,'file']]) assert.deepEqual(chain(trace(await preview(body,kind)), kind, body.name).steps, []);
  });
  const childA = { ...source, name: 'trace-child-a', process: [identity] };
  const childB = { ...source, name: 'trace-child-b', process: [identity] };
  await success('/api/subs', childA); await success('/api/subs', childB);
  const collection = { name: 'trace-collection', subscriptions: [childA.name, childB.name], process: [identity] };
  await success('/api/collections', collection);
  await check('组合子来源并发采集及组合自身分别成链', async () => {
    const result = trace(await preview(collection, 'collection'), 'collection');
    assert.equal(result.chains.length, 3); assert.equal(chain(result,'sub',childA.name).steps[0].inputCount,1); assert.equal(chain(result,'sub',childB.name).steps[0].outputCount,1); assert.equal(chain(result,'collection',collection.name).steps[0].inputCount,2);
  });
  await check('Mihomo 文件的来源、组合和文件链均记录', async () => {
    const body = { name: 'trace-mihomo', type: 'mihomoConfig', sourceType: 'collection', sourceName: collection.name, process: [script('$content += "\\n# trace-ok";')] };
    const result = await preview(body, 'file'); assert.match(result.processed, /trace-ok/);
    const value = trace(result, 'mihomo'); assert.equal(value.chains.length,4); assert.equal(chain(value,'collection',collection.name).steps[0].outputCount,2); assert.equal(chain(value,'file',body.name).steps[0].inputCount,undefined);
  });
  const failedChild = { ...source, name: 'trace-failed-child', process: [broken, identity] }; await success('/api/subs', failedChild);
  const slowChild = { ...source, name: 'trace-slow-child', process: [script('async function operator(proxies) { await new Promise(resolve => setTimeout(resolve, 60)); return proxies; }')] }; await success('/api/subs', slowChild);
  const failedCollection = { name: 'trace-failed-collection', subscriptions: [failedChild.name, slowChild.name], process: [identity] }; await success('/api/collections', failedCollection);
  await check('并发子链全部结束后报告失败，未进入的父链不伪造', async () => {
    for (const [body,kind] of [[failedCollection,'collection'],[{ name: 'failed-mihomo', type:'mihomoConfig', sourceType:'collection', sourceName:failedCollection.name, process:[identity] },'file']]) {
      const value = trace(await failure(body,kind), `nested-failure-${kind}`); assert.equal(value.chains.length,2); assert.deepEqual(chain(value,'sub',failedChild.name).steps.map(s=>s.status), ['failed','not-run']); assert.equal(chain(value,'sub',slowChild.name).steps[0].status,'success');
    }
  });
  await check('Mihomo 空来源通过内置添加节点步骤进入来源与组合处理链', async () => {
    for (const [sourceType,sourceName,expectedChains] of [['subscription',childA.name,2],['collection',collection.name,4]]) {
      const body={name:`trace-add-${sourceType}`,type:'mihomoConfig',sourceType:'none',process:[{type:'Add Proxies From Subscription Operator',args:{sourceType,sourceName}},identity]};
      const result=await preview(body,'file'); assert.match(result.processed,/HK synthetic/); const value=trace(result,`add-proxies-${sourceType}`);
      assert.equal(value.chains.length,expectedChains); assert.equal(chain(value,'sub',childA.name).steps[0].status,'success'); assert.deepEqual(chain(value,'file',body.name).steps.map(s=>s.status),['success','success']);
      if(sourceType==='collection')assert.equal(chain(value,'collection',collection.name).steps[0].status,'success');
    }
  });
  await check('内置添加节点子链失败保留真实身份及外层 failed/not-run', async () => {
    for (const [sourceType,sourceName] of [['subscription',failedChild.name],['collection',failedCollection.name]]) {
      const body={name:`trace-add-failed-${sourceType}`,type:'mihomoConfig',sourceType:'none',process:[{type:'Add Proxies From Subscription Operator',args:{sourceType,sourceName}},identity]};
      const error=await failure(body,'file'); assert.equal(error.processor.scope.name,failedChild.name); const value=trace(error,`add-proxies-failed-${sourceType}`);
      assert.deepEqual(chain(value,'sub',failedChild.name).steps.map(s=>s.status),['failed','not-run']); assert.deepEqual(chain(value,'file',body.name).steps.map(s=>s.status),['failed','not-run']);
    }
  });
  await check('脚本注入 produceArtifact 在操作及过滤脚本中继承预览 trace', async () => {
    for (const [type,shortcut] of [['Script Operator',false],['Script Filter',false],['Script Operator',true],['Script Filter',true]]) {
      const entry=type==='Script Filter'?'filter':'operator'; const returned=type==='Script Filter'?'proxies.map(()=>true)':'proxies';
      const call=`await produceArtifact({type:"collection",name:"${collection.name}"});`;
      const content=shortcut?`${call} ${entry==='filter'?'return true;':''}`:`async function ${entry}(proxies) { ${call} return ${returned}; }`;
      const result=await preview({...source,process:[{type,args:{mode:'script',content}}]});
      const value=trace(result,`script-artifact-${entry}${shortcut?'-shortcut':''}`); assert.equal(value.chains.length,4); assert.equal(chain(value,'collection',collection.name).steps[0].status,'success');
    }
    const error=await failure({...source,process:[script(`async function operator() { await produceArtifact({type:"subscription",name:"${failedChild.name}"}); }`),identity]});
    const value=trace(error,'script-artifact-failed'); assert.equal(error.processor.scope.name,failedChild.name); assert.deepEqual(chain(value,'sub',source.name).steps.map(s=>s.status),['failed','not-run']); assert.deepEqual(chain(value,'sub',failedChild.name).steps.map(s=>s.status),['failed','not-run']);
  });
  await success('/api/files',{...file,name:'trace-download-file',content:source.content,process:[identity]});
  await success('/api/files',{...file,name:'trace-download-failed-file',process:[broken,identity]});
  await success('/api/subs',{...source,name:'trace-local-file-source',source:'remote',url:'/api/file/trace-download-file',process:[identity]});
  await check('来源和文件预览经本地文件下载依赖时记录实际子链', async () => {
    const localSource={...source,name:'trace-local-file-source',source:'remote',url:'/api/file/trace-download-file',process:[identity]};
    for (const [body,kind] of [[localSource,'sub'],[{name:'trace-download-collection',subscriptions:[localSource.name],process:[identity]},'collection'],[{...file,name:'trace-file-via-file',source:'remote',url:'/api/file/trace-download-file',process:[identity]},'file'],[{name:'trace-mihomo-via-file',type:'mihomoConfig',sourceType:'subscription',sourceName:localSource.name,process:[identity]},'file']]) {
      const value=trace(await preview(body,kind),`local-file-download-${kind}-${body.name}`); assert.equal(chain(value,'file','trace-download-file').steps[0].status,'success');
    }
    const error=await failure({...source,source:'remote',url:'/api/file/trace-download-failed-file'}); assert.deepEqual(chain(trace(error,'local-file-download-failed'),'file','trace-download-failed-file').steps.map(s=>s.status),['failed','not-run']);
  });
  await success('/api/files', { ...file, name: 'trace-script-file', content: 'function operator(proxies) { return proxies; }', process: [script('$content += "\\n// local script dependency";')] });
  await check('本地脚本文件依赖具有独立链且不混淆外层步骤', async () => {
    const value = trace(await preview({ ...source, process: [script('', { args: { mode: 'link', content: '/api/file/trace-script-file' } })] })); assert.equal(value.chains.length,2); assert.equal(chain(value,'file','trace-script-file').steps[0].status,'success'); assert.equal(chain(value,'sub',source.name).steps[0].status,'success');
  });
  await check('并发请求 trace 隔离', async () => {
    const results = await Promise.all(Array.from({length:8}, (_,i) => preview({ ...source, name:`trace-request-${i}`, process: [script(`async function operator(proxies) { await new Promise(resolve => setTimeout(resolve, ${10+i*5})); return proxies; }`)] })));
    results.forEach((result,i)=>assert.deepEqual(trace(result).chains.map(c=>c.scope.name), [`trace-request-${i}`]));
  });
  await check('单次执行：成功与失败脚本各运行一次', async () => {
    await preview({ ...source, process: [script('function operator(proxies) { globalThis.__traceSuccess = (globalThis.__traceSuccess || 0) + 1; return proxies; }')] });
    await failure({ ...source, process: [script('function operator() { globalThis.__traceFailure = (globalThis.__traceFailure || 0) + 1; throw new Error("count-failure"); }')] });
    const result = await preview({ ...source, process: [script('function operator(proxies) { proxies[0].name = globalThis.__traceSuccess + ":" + globalThis.__traceFailure; return proxies; }')] }); assert.equal(result.processed[0].name,'1:1'); trace(result);
  });
  await check('执行上下文篡改无法改变预先捕获的 scope 或后续名称', async () => {
    const result = trace(await preview({ ...source, process: [script('function operator(proxies, target, context) { context.source["trace-source"].name = "wrong-name"; context.source["trace-source"].process[1].customName = "wrong-step"; return proxies; }'), { ...identity, customName:'真实步骤' }] }));
    assert.equal(result.chains[0].scope.name,source.name); assert.equal(result.chains[0].steps[1].name,'真实步骤');
  });
  await check('最多 200 步与 8000 字符，尾部失败仍优先保留且不重放', async () => {
    const process = Array.from({length:205}, ()=>({type:'Unknown Skipped Operator',disabled:true})); process.push(broken, identity);
    const value = trace(await failure({ ...source,process }), 'bounded-failure'); assert.equal(value.truncated,true); assert.ok(value.chains[0].steps.some(s=>s.index===205&&s.status==='failed')); assert.ok(!value.chains[0].steps.some(s=>s.index>205&&s.status==='success'));
  });
  await check('大量成功步骤限长不改变真实执行次数及最终内容', async () => {
    const result=await preview({...source,process:Array.from({length:220},()=>script('function operator(proxies) { proxies[0].port += 1; return proxies; }'))});
    assert.equal(result.processed[0].port,663); const value=trace(result,'bounded-success'); assert.equal(value.truncated,true); assert.ok(value.chains[0].steps.length<220);
  });
  await check('大量并发子链超过预算时仍保留晚到的失败链', async () => {
    const subscriptions=[];
    for(let i=0;i<125;i++) { const name=`bounded-child-${i}`; subscriptions.push(name); await success('/api/subs',{...source,name,process:[identity]}); }
    await success('/api/subs',{...source,name:'bounded-late-failure',process:[script('async function operator() { await new Promise(resolve => setTimeout(resolve, 80)); throw new Error("late-failure"); }')]}); subscriptions.push('bounded-late-failure');
    const value=trace(await failure({name:'bounded-collection',subscriptions,process:[identity]},'collection'),'bounded-chains'); assert.equal(value.truncated,true); assert.equal(chain(value,'sub','bounded-late-failure').steps[0].status,'failed'); assert.ok(!value.chains.some(c=>c.scope.kind==='collection'));
  });
  await check('本地文件依赖失败保留子链原因及外层失败与 not-run', async () => {
    await success('/api/files',{...file,name:'trace-failed-script-file',process:[broken,identity]});
    const error=await failure({...source,process:[script('',{args:{mode:'link',content:'/api/file/trace-failed-script-file'}}),identity]});
    const value=trace(error,'failed-script-file'); assert.equal(error.processor.scope.name,'trace-failed-script-file'); assert.deepEqual(chain(value,'sub',source.name).steps.map(s=>s.status),['failed','not-run']); assert.deepEqual(chain(value,'file','trace-failed-script-file').steps.map(s=>s.status),['failed','not-run']);
  });
  await check('损坏的处理器类型不改写旧 error.processor 身份或伪装合法 trace 步骤', async () => {
    const error=await failure({...source,process:[{type:37}]}); assert.equal(error.processor.type,37); const value=trace(error); assert.equal(value.truncated,true); assert.equal(value.chains[0].steps.length,0);
  });
  await check('超大身份整体省略，不截断名称伪装为另一对象', async () => {
    const longName = '身份'.repeat(5000);
    const result = trace(await preview({ ...source, name:longName, process:[identity] })); assert.equal(result.truncated,true); assert.equal(result.chains.length,0);
    const steps = trace(await failure({ ...source, process:[{...identity,customName:longName},broken] })).chains[0].steps; assert.ok(steps.every(s=>s.name===undefined||s.name===longName||s.name==='失败步骤')); assert.ok(steps.some(s=>s.index===1&&s.status==='failed'));
  });
  await check('错误转义膨胀与丰富 trace 同时存在仍适配原生 16KiB 通道', async () => {
    const process = Array.from({length:50},()=>identity); process.push(script('function operator() { throw new Error("long-failure " + "\\u0000".repeat(30000)); }', {customName:'失败'.repeat(500)}));
    const error = await failure({...source,name:'source'.repeat(200),process}); trace(error); assert.match(error.details,/long-failure/); assert.ok(JSON.stringify(error).length < 16000);
  });
  fixture = http.createServer(async (req,res) => {
    if (req.url.startsWith('/nodes')) { await pause(220); res.end(source.content); }
    else { await pause(80); res.end('async function operator(proxies) { await new Promise(resolve => setTimeout(resolve, 40)); return proxies; }'); }
  }); fixture.listen(0,'127.0.0.1'); await once(fixture,'listening'); const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;
  await check('耗时包括脚本加载及异步处理，但排除来源下载', async () => {
    const result = await preview({...source,source:'remote',url:`${fixtureUrl}/nodes?unique=${Date.now()}`,noCache:true,process:[identity,script('',{args:{mode:'link',content:`${fixtureUrl}/script`}})]});
    const steps=trace(result,'timing').chains[0].steps; assert.ok(steps[0].durationMs<150); assert.ok(steps[1].durationMs>=100);
  });
  await check('普通下载保持内容且不暴露预览 trace', async () => {
    const response=await fetch(`http://127.0.0.1:${port}/download/${source.name}?target=JSON`); assert.equal(response.status,200); const text=await response.text(); const parsed=JSON.parse(text); assert.ok(Array.isArray(parsed)); assert.equal(parsed[0].name,node.name); assert.equal(parsed.trace,undefined); assert.ok(!text.includes('durationMs'));
  });
  await check('保存状态在成功、失败、组合预览及服务重启后保持完整', async () => {
    const before=await state(); await preview(collection,'collection'); await failure({...source,process:[broken]}); await preview({...file,process:[script('$file.name="mutated"; $content += " temporary";')]},'file'); assert.deepEqual(await state(),before);
    await stop(); await start(); assert.deepEqual(await state(),before); trace(await preview(source));
  });
  report.status = report.checks.every(item=>item.status==='passed')?'passed':'failed'; if(report.status!=='passed')process.exitCode=1;
}
main().catch(error=>{report.status='failed';report.error=error.stack;process.exitCode=1;}).finally(async()=>{
  await stop(); if(fixture)await new Promise(resolve=>fixture.close(resolve)); log.end(); report.processStopped=!child||child.exitCode!==null||child.signalCode!==null;
  fs.writeFileSync(path.join(data,'acceptance.json'),JSON.stringify(report,null,2)); console.log(`Report: ${path.join(data,'acceptance.json')}`);
});
