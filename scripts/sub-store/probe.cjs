// 本地可丢弃的完整引擎验证。只操作合成数据，不接触 PP Clash 用户目录。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: pause } = require('node:timers/promises');
const root = path.resolve(__dirname, '../../.cache/cloud-tools-20261121/runtime');
const data = fs.mkdtempSync(path.join(root, 'data-'));
const bundle = path.resolve(process.env.SUB_STORE_TEST_BUNDLE || path.join(root, 'sub-store.strict.bundle.cjs'));
const reportPath = path.resolve(process.env.SUB_STORE_TEST_REPORT || path.join(root, 'acceptance-strict.json'));
const checks = [];
const report = { runtime:process.version, platform:process.platform, arch:process.arch, engine:'2.44.16', bundle, data, checks };
let child, port, fixture;
const log = fs.createWriteStream(path.join(data,'server.log'));
const nodes = (entries) => JSON.stringify({proxies:entries.map(([name,server])=>({name,type:'trojan',server,port:443,password:'synthetic-test-only',sni:'example.invalid'}))});
async function freePort() {
  const reservation = http.createServer(); reservation.listen(0,'127.0.0.1'); await once(reservation,'listening');
  const value=reservation.address().port; await new Promise(resolve=>reservation.close(resolve)); return value;
}
async function start() {
  port=await freePort();
  child=spawn(process.execPath,[bundle],{cwd:data,env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'en_US.UTF-8',SUB_STORE_DATA_BASE_PATH:data,SUB_STORE_BACKEND_API_HOST:'127.0.0.1',SUB_STORE_BACKEND_API_PORT:String(port),SUB_STORE_FRONTEND_BACKEND_PATH:'/'},stdio:['ignore','pipe','pipe']});
  child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
  for(let count=0;count<80;count++) {
    if(child.exitCode!==null) throw new Error('Engine exited before ready: '+child.exitCode);
    try { const response=await fetch(`http://127.0.0.1:${port}/api/subs`,{signal:AbortSignal.timeout(500)}); if(response.ok) return; } catch{}
    await pause(100);
  }
  throw new Error('Engine readiness timeout');
}
async function stop() {
  if(!child||child.exitCode!==null)return;
  const exit=once(child,'exit');child.kill('SIGTERM');
  const timer=setTimeout(()=>child.kill('SIGKILL'),3000);
  await exit;clearTimeout(timer);child=null;
}
async function api(route,body,method=body===undefined?'GET':'POST') {
  const response=await fetch(`http://127.0.0.1:${port}${route}`,{method,headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(7000)});
  const text=await response.text();let value;try{value=JSON.parse(text);}catch{value=text;}
  return {status:response.status,value};
}
async function success(route,body,method) {
  const result=await api(route,body,method);
  assert.ok(result.status>=200&&result.status<300,`${route}: HTTP ${result.status} ${JSON.stringify(result.value).slice(0,350)}`);
  assert.equal(result.value.status,'success',`${route}: ${JSON.stringify(result.value).slice(0,350)}`);
  return result.value.data;
}
async function check(name,action) { try { await action();checks.push({name,status:'passed'});console.log('PASS '+name); } catch(error) { checks.push({name,status:'failed',error:error.message});console.error('FAIL '+name+': '+error.message); } }
const scriptStep = (type,content) => ({type,args:{mode:'script',content}});
async function state() {
  const saved = {};
  for (const route of ['/api/subs','/api/collections','/api/wholeFiles','/api/settings']) saved[route] = await success(route);
  return saved;
}
async function failure(route,body,reason) {
  const before = await state();
  const result = await api(route,body);
  fs.writeFileSync(path.join(data, `failure-${report.failures?.length || 0}.json`), JSON.stringify(result,null,2));
  (report.failures ||= []).push({route,expectedReason:reason,result});
  assert.deepEqual(await state(),before,'failed processing must not change saved state');
  assert.equal(result.value.status,'failed',JSON.stringify(result.value).slice(0,350));
  assert.ok(result.status >= 400,`expected failed HTTP status, got ${result.status}`);
  assert.ok(JSON.stringify(result.value.error).includes(reason),`lost error reason: ${JSON.stringify(result.value)}`);
}
async function main() {
  await start();
  report.startRssKiB=Number(execFileSync('ps',['-o','rss=','-p',String(child.pid)],{encoding:'utf8'}).trim());
  const a={name:'source-a',source:'local',content:nodes([['HK 01','a.example.invalid'],['JP 01','b.example.invalid']]),process:[]};
  const b={name:'source-b',source:'local',content:nodes([['HK duplicate','a.example.invalid'],['SG 01','c.example.invalid']]),process:[]};
  await check('single subscription create and read',async()=>{await success('/api/subs',a);const read=await success('/api/sub/source-a');assert.equal(read.content,a.content);});
  await success('/api/subs',b);
  const recipe={name:'daily',subscriptions:['source-a','source-b'],process:[
    {type:'Regex Filter',args:{regex:['HK|SG'],keep:true}},
    {type:'Handle Duplicate Operator',args:{action:'delete',field:['server','port']}},
    {type:'Regex Rename Operator',args:[{expr:'^HK',now:'香港'},{expr:'^SG',now:'新加坡'}]},
  ]};
  await check('collection official filters dedupe rename and Mihomo export',async()=>{
    await success('/api/collections',recipe);
    const result=await api('/download/collection/daily?target=Mihomo');assert.equal(result.status,200);
    const raw=typeof result.value==='string'?result.value:JSON.stringify(result.value);
    assert.match(raw,/香港 01/);assert.match(raw,/新加坡 01/);assert.doesNotMatch(raw,/JP 01|HK duplicate/);
    fs.writeFileSync(path.join(data,'mihomo-output.yaml'),raw);
  });
  await check('single-source official script processing',async()=>{
    const body={...a,process:[{type:'Script Operator',args:{content:'function operator(proxies) { return proxies.map(p => ({...p, name: "QA " + p.name})); }',mode:'script'}}]};
    const preview=await success('/api/preview/sub',body);fs.writeFileSync(path.join(data,'script-preview.json'),JSON.stringify(preview,null,2));
    assert.match(JSON.stringify(preview),/QA HK 01/);
  });
  await check('official local file create preview and read',async()=>{
    const file={name:'qa-rules',source:'local',content:'rules:\n  - DOMAIN-SUFFIX,example.invalid,DIRECT\n',process:[]};
    await success('/api/files',file);
    const result=await api('/api/file/qa-rules');assert.equal(result.status,200);assert.match(typeof result.value==='string'?result.value:JSON.stringify(result.value),/DOMAIN-SUFFIX/);
    const preview=await success('/api/preview/file',file);assert.match(preview.processed,/example.invalid/);
  });
  fixture=http.createServer((req,res)=>{res.writeHead(404);res.end('synthetic missing source');});fixture.listen(0,'127.0.0.1');await once(fixture,'listening');
  await check('failed remote preview does not change saved subscription',async()=>{
    const before=await success('/api/sub/source-a');
    const result=await api('/api/preview/sub',{...a,source:'remote',url:`http://127.0.0.1:${fixture.address().port}/missing`});
    assert.equal(result.value.status,'failed');
    const after=await success('/api/sub/source-a');assert.deepEqual(after,before);
  });
  await check('invalid script returns failure without publishing a change',async()=>{
    const before=await success('/api/collection/daily');
    const result=await api('/api/preview/collection',{...recipe,process:[{type:'Script Operator',args:{mode:'script',content:'function operator() { throw new Error("synthetic failure"); }'}}]});
    fs.writeFileSync(path.join(data,'failed-script-response.json'),JSON.stringify(result,null,2));
    assert.equal(result.value.status,'failed');assert.deepEqual(await success('/api/collection/daily'),before);
  });
  for (const [label,type,content,reason] of [
    ['explicit operator','Script Operator','function operator(proxies) { proxies[0].name = "MUTATED"; throw new Error("operator-failure"); }','operator-failure'],
    ['async operator','Script Operator','async function operator() { await Promise.resolve(); throw new Error("async-operator-failure"); }','async-operator-failure'],
    ['explicit filter','Script Filter','function filter() { throw new Error("filter-failure"); }','filter-failure'],
    ['async filter','Script Filter','const filter = async () => { throw new Error("async-filter-failure"); };','async-filter-failure'],
    ['arrow operator','Script Operator','const operator = () => { throw new Error("arrow-failure"); };','arrow-failure'],
    ['destructured operator','Script Operator','const { operator } = { operator() { throw new Error("destructured-failure"); } };','destructured-failure'],
    ['misleading reference error','Script Operator','function operator() { throw new ReferenceError("$server is not defined: explicit-failure"); }','explicit-failure'],
    ['initialization error','Script Operator','throw new Error("initialization-failure"); function operator(proxies) { return proxies; }','initialization-failure'],
    ['shortcut operator error','Script Operator','throw new Error("shortcut-operator-failure");','shortcut-operator-failure'],
    ['shortcut filter error','Script Filter','throw new Error("shortcut-filter-failure");','shortcut-filter-failure'],
    ['unknown processor','Missing Processor',null,'Missing Processor'],
    ['inherited processor','constructor',null,'constructor'],
    ['syntax error','Script Operator','function operator( {','Unexpected'],
  ]) {
    await check(`${label} fails with reason and preserves saved state`,()=>failure('/api/preview/sub',{...a,process:[scriptStep(type,content)]},reason));
  }
  await check('empty input explicit operator still fails',()=>failure('/api/preview/sub',{...a,content:'{"proxies":[]}',process:[scriptStep('Script Operator','function operator() { throw new Error("empty-input-failure"); }')]},'empty-input-failure'));
  for (const mode of ['quiet','fallbackQuiet','fallbackNotify']) {
    await check(`subscription ${mode} cannot swallow processor errors`,()=>failure('/api/preview/sub',{...a,ignoreFailedRemoteSub:mode,process:[scriptStep('Script Operator','function operator() { throw new Error("strict-sub-failure"); }')]},'strict-sub-failure'));
    await check(`collection ${mode} cannot swallow processor errors`,()=>failure('/api/preview/collection',{...recipe,ignoreFailedRemoteSub:mode,process:[scriptStep('Script Filter','function filter() { throw new Error("strict-collection-failure"); }')]},'strict-collection-failure'));
  }
  await check('shortcut operator executes once per node',async()=>{
    const result=await success('/api/preview/sub',{...a,process:[scriptStep('Script Operator','globalThis.__strictQaCounter = (globalThis.__strictQaCounter || 0) + 1; $server.name = "shortcut-" + globalThis.__strictQaCounter;')]});
    assert.deepEqual(result.processed.map(p=>p.name),['shortcut-1','shortcut-2']);
  });
  await check('shortcut filter retains matching node',async()=>{
    const result=await success('/api/preview/sub',{...a,process:[scriptStep('Script Filter','await Promise.resolve(); return $server.name.startsWith("JP");')]});
    assert.deepEqual(result.processed.map(p=>p.name),['JP 01']);
  });
  await check('shortcut nested function does not declare an entry point',async()=>{
    const result=await success('/api/preview/sub',{...a,process:[scriptStep('Script Operator','function helper() { function operator() { throw new Error("unreachable"); } return "nested "; } $server.name = helper() + $server.name;')]});
    assert.deepEqual(result.processed.map(p=>p.name),['nested HK 01','nested JP 01']);
  });
  await check('function text in comment or string does not select explicit mode',async()=>{
    const result=await success('/api/preview/sub',{...a,process:[scriptStep('Script Operator','// function operator() {}\nconst label = "function operator() {}"; $server.name = "literal " + $server.name;')]});
    assert.deepEqual(result.processed.map(p=>p.name),['literal HK 01','literal JP 01']);
  });
  await check('explicit async operator and filter remain compatible',async()=>{
    const result=await success('/api/preview/sub',{...a,process:[scriptStep('Script Operator','const operator = async proxies => proxies.map(p => ({...p, name: "async " + p.name}));'),scriptStep('Script Filter','async function filter(proxies) { return proxies.map(p => p.name.includes("HK")); }')]});
    assert.deepEqual(result.processed.map(p=>p.name),['async HK 01']);
  });
  await check('file shortcut and Mihomo YAML patch remain compatible',async()=>{
    const plain=await success('/api/preview/file',{name:'plain',source:'local',content:'original',process:[scriptStep('Script Operator','$content += " modified";')]});
    assert.equal(plain.processed,'original modified');
    const yaml=await success('/api/preview/file',{name:'config',type:'mihomoConfig',sourceType:'local',content:'mixed-port: 7890\n',process:[scriptStep('Script Operator','mixed-port: 7891\n')]});
    assert.match(yaml.processed,/mixed-port: 7891/);
  });
  await check('Mihomo main shortcut remains compatible',async()=>{
    const result=await success('/api/preview/file',{name:'config',type:'mihomoConfig',sourceType:'local',content:'mixed-port: 7890\n',process:[scriptStep('Script Operator','function main(config) { config["mixed-port"] = 7892; return config; }')]});
    assert.match(result.processed,/mixed-port: 7892/);
  });
  await check('explicit file operator failure preserves saved state',()=>failure('/api/preview/file',{name:'qa-rules',source:'local',content:'original',process:[scriptStep('Script Operator','function operator(input) { input.$content = "MUTATED"; throw new Error("file-failure"); }')]},'file-failure'));
  const badSub={...a,name:'failure-source',ignoreFailedRemoteSub:'fallbackQuiet',process:[scriptStep('Script Operator','function operator() { throw new Error("nested-source-failure"); }')]};
  await success('/api/subs',badSub);
  const badCollection={name:'failure-collection',subscriptions:['source-b','failure-source'],ignoreFailedRemoteSub:'fallbackQuiet',process:[]};
  await success('/api/collections',badCollection);
  await check('nested subscription failure survives collection preview fallback',()=>failure('/api/preview/collection',badCollection,'nested-source-failure'));
  await check('subscription download failure keeps reason and state',()=>failure('/download/failure-source?target=Mihomo',undefined,'nested-source-failure'));
  await check('collection download failure keeps reason and state',()=>failure('/download/collection/failure-collection?target=Mihomo',undefined,'nested-source-failure'));
  await success('/api/subs',{...a,name:'mutation-source',process:[scriptStep('Script Operator','function operator(proxies, target, context) { context.source["mutation-source"].content = "MUTATED"; throw new Error("source-mutation-failure"); }')]});
  await check('failing script cannot mutate saved subscription through context',()=>failure('/download/mutation-source?target=Mihomo',undefined,'source-mutation-failure'));
  await success('/api/collections',{name:'mutation-collection',subscriptions:['source-a'],process:[scriptStep('Script Filter','function filter(proxies, target, context) { context.source._collection.subscriptions = []; throw new Error("collection-mutation-failure"); }')]});
  await check('failing filter cannot mutate saved collection through context',()=>failure('/download/collection/mutation-collection?target=Mihomo',undefined,'collection-mutation-failure'));
  for (const [kind,endpoint] of [['sub','/download/args-source?target=Mihomo'],['collection','/download/collection/args-collection?target=Mihomo']]) {
    const step={type:'Script Operator',args:{mode:'script',arguments:{marker:'original',nested:{marker:'original'}},content:'function operator() { $arguments.marker = "changed"; $arguments.nested.marker = "changed"; throw new Error("args-failure"); }'}};
    if(kind==='sub') await success('/api/subs',{...a,name:'args-source',process:[step]});
    else await success('/api/collections',{name:'args-collection',subscriptions:['source-a'],process:[step]});
    await check(`${kind} script arguments remain unchanged after failure`,()=>failure(endpoint,undefined,'args-failure'));
  }
  await success('/api/files',{name:'broken-script-source',source:'local',content:'function operator(proxies) { return proxies; }',process:[scriptStep('Script Operator','function operator() { throw new Error("linked-file-failure"); }')]});
  const linkedStep={type:'Script Operator',args:{mode:'link',content:'/api/file/broken-script-source'}};
  for (const mode of ['quiet','fallbackQuiet','fallbackNotify']) {
    await check(`linked file ${mode} preserves processor loading failure`,()=>failure('/api/preview/sub',{...a,ignoreFailedRemoteSub:mode,process:[linkedStep]},'linked-file-failure'));
    await check(`constructor ${mode} cannot hide invalid processor arguments`,()=>failure('/api/preview/sub',{...a,ignoreFailedRemoteSub:mode,process:[{type:'Regex Delete Operator',args:{}}]},'Regex Delete Operator'));
  }
  await success('/api/subs',{...a,name:'linked-source',ignoreFailedRemoteSub:'fallbackQuiet',process:[linkedStep]});
  await check('linked script download loading failure retains original reason',()=>failure('/download/linked-source?target=Mihomo',undefined,'linked-file-failure'));
  await success('/api/collections',{name:'linked-collection',subscriptions:['source-a','linked-source'],ignoreFailedRemoteSub:'fallbackQuiet',process:[]});
  await check('nested collection loading failure retains original reason',()=>failure('/download/collection/linked-collection?target=Mihomo',undefined,'linked-file-failure'));
  await check('missing linked script is processing failure despite fallback',()=>failure('/api/preview/sub',{...a,ignoreFailedRemoteSub:'fallbackQuiet',process:[{type:'Script Operator',args:{mode:'link',content:'/api/file/missing-script'}}]},'missing-script'));
  await check('remote linked script download is processing failure despite fallback',()=>failure('/api/preview/sub',{...a,ignoreFailedRemoteSub:'fallbackQuiet',process:[{type:'Script Operator',args:{mode:'link',content:`http://127.0.0.1:${fixture.address().port}/missing-script`}}]},'missing-script'));
  for (const [label,content] of [
    ['loop scoped const','for (const operator of ["prefix "]) { $server.name = operator + $server.name; }'],
    ['block scoped let','{ let operator = "prefix "; $server.name = operator + $server.name; }'],
    ['block scoped assignment','{ let operator; operator = "prefix "; $server.name = operator + $server.name; }'],
    ['catch parameter','try { throw "prefix "; } catch (operator) { $server.name = operator + $server.name; }'],
  ]) {
    await check(`${label} does not declare explicit operator`,async()=>{
      const result=await success('/api/preview/sub',{...a,process:[scriptStep('Script Operator',content)]});
      assert.deepEqual(result.processed.map(p=>p.name),['prefix HK 01','prefix JP 01']);
    });
  }
  await check('loop scoped filter binding remains shortcut',async()=>{
    const result=await success('/api/preview/sub',{...a,process:[scriptStep('Script Filter','for (const filter of ["HK"]) { return $server.name.startsWith(filter); }')]});
    assert.deepEqual(result.processed.map(p=>p.name),['HK 01']);
  });
  await check('function scoped var in block remains explicit entry',()=>failure('/api/preview/sub',{...a,process:[scriptStep('Script Operator','if (true) { var operator = () => { throw new Error("function-scope-failure"); }; }')]},'function-scope-failure'));
  await success('/api/file/broken-script-source',undefined,'DELETE');
  await check('restart retains subscriptions collections and files',async()=>{
    const beforeRestart = await state();
    await stop();await start();
    assert.deepEqual(await state(),beforeRestart);
    assert.equal((await success('/api/sub/source-a')).content,a.content);
    assert.deepEqual((await success('/api/collection/daily')).subscriptions,recipe.subscriptions);
    assert.equal((await success('/api/wholeFiles')).length,1);
  });
  report.endRssKiB=Number(execFileSync('ps',['-o','rss=','-p',String(child.pid)],{encoding:'utf8'}).trim());
  await check('rename keeps collection source reference',async()=>{
    await success('/api/sub/source-a',{name:'source-renamed'},'PATCH');
    const collection=await success('/api/collection/daily');assert.ok(collection.subscriptions.includes('source-renamed'));
  });
  report.status=checks.every(item=>item.status==='passed')?'passed':'partially_verified';
  if(report.status!=='passed')process.exitCode=1;
}
main().catch(error=>{report.status='failed';report.error=error.stack;console.error(error.message);process.exitCode=1;}).finally(async()=>{
  await stop();if(fixture)await new Promise(resolve=>fixture.close(resolve));log.end();
  report.processStopped=!child;
  fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
  console.log('Report: '+reportPath);
});
