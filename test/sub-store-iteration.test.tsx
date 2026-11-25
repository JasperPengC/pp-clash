// @vitest-environment happy-dom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EntryEditor } from '../src/components/sub-store/EntryEditor';
import { PreviewResults } from '../src/components/sub-store/PreviewResults';
import { Segmented } from '../src/components/ui';
import type { Entry } from '../src/components/sub-store/model';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { createWriteStream, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// CodeMirror 的几何测量不适用于 happy-dom；只替代与本轮表单无关的代码编辑器。
vi.mock('../src/components/CodeEditor', () => ({ default: ({ value }: { value: string }) => createElement('textarea', { value, readOnly: true }) }));
let root: Root; let host: HTMLDivElement; let saved: Entry;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const click = async (element: Element) => { expect(element, '操作入口应存在').toBeTruthy(); await act(async () => (element as HTMLElement).click()); };
const button = (text: string) => [...host.querySelectorAll('button')].find(element => element.textContent?.trim() === text)!;
const fill = async (label: string, value: string) => act(async () => {
  const element = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  expect(element, `字段 ${label} 应存在`).toBeTruthy();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
});
const choose = async (label: string, text: string) => {
  await click(host.querySelector(`[aria-label="${label}"]`)!);
  await click([...document.querySelectorAll('[role="listbox"] [role="option"]')].find(element => element.textContent?.trim() === text)!);
};
async function editor(entry: Entry, kind: 'sub' | 'file' = 'sub') {
  function Harness() {
    const [value, setValue] = useState(entry); saved = value;
    return <EntryEditor kind={kind} entry={value} sources={[]} busy={false} onChange={setValue} onValidity={() => {}} onJsonDraft={() => {}} onSectionChange={() => {}} editorSection="process" />;
  }
  await act(async () => root.render(<Harness />));
}
it.each([
  ['Type Filter', ['ss'], '协议筛选', 'trojan', ['ss', 'trojan']],
  ['Region Filter', ['HK'], '地区筛选', '日本', ['HK', 'JP']],
] as const)('%s 的旧数组配置可操作并保留处理器额外字段', async (type, args, _title, option, expected) => {
  await editor({ name: 'source', process: [{ type, args: [...args], custom: 'kept' }] });
  await click(host.querySelector(`[aria-label="${option}"]`)!);
  expect(saved.process?.[0]).toEqual({ type, custom: 'kept', args: { value: [...expected], keep: true } });
  await choose('筛选方式', '排除匹配');
  expect(saved.process?.[0].args).toEqual({ value: [...expected], keep: false });
});
it('协议筛选保留高级未知值与参数，不默默删除导入的协议', async () => {
  await editor({ name: 'source', process: [{ type: 'Type Filter', args: { value: ['future-protocol'], keep: false, advanced: { keep: true } } }] });
  await click(host.querySelector('[aria-label="ss"]')!);
  expect(saved.process?.[0].args).toEqual({ value: ['future-protocol', 'ss'], keep: false, advanced: { keep: true } });
  expect(host.textContent).toContain('future-protocol');
});
it('重复节点支持按服务器和端口去重并保留自定义编号模板', async () => {
  await editor({ name: 'source', process: [{ type: 'Handle Duplicate Operator', args: { action: 'rename', field: ['name'], template: '零 一 二 三 四 五 六 七 八 九', extra: 'keep' } }] });
  await choose('重复判定', '服务器与端口'); await choose('重复处理', '保留首个，删除重复');
  expect(saved.process?.[0].args).toMatchObject({ action: 'delete', field: ['server', 'port'], template: '零 一 二 三 四 五 六 七 八 九', extra: 'keep' });
});
it('重新选择当前自定义重复判定不丢失密码等高级字段', async () => {
  await editor({ name: 'source', process: [{ type: 'Handle Duplicate Operator', args: { action: 'delete', field: ['server', 'port', 'password'] } }] });
  await choose('重复判定', '自定义字段（完整参数）');
  expect(saved.process?.[0].args).toEqual({ action: 'delete', field: ['server', 'port', 'password'] });
});
it('分段控件键盘导航跳过禁用项，全部禁用时不切换', async () => {
  const change = vi.fn();
  const options = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', disabled: true }, { value: 'c', label: 'C' }];
  await act(async () => root.render(<Segmented options={options} value="a" onChange={change} tabPanelId="panel" />));
  await act(async () => button('A').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(change).toHaveBeenLastCalledWith('c'); change.mockClear();
  await act(async () => root.render(<Segmented options={options} value="c" onChange={change} tabPanelId="panel" />));
  await act(async () => button('C').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
  expect(change).toHaveBeenLastCalledWith('a'); change.mockClear();
  await act(async () => root.render(<Segmented options={options.map(option => ({ ...option, disabled: true }))} value="a" onChange={change} tabPanelId="panel" />));
  await act(async () => button('A').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
  expect(change).not.toHaveBeenCalled();
});
it('快捷参数的沿用/启用/关闭是三态，不把沿用错误转换为false', async () => {
  await editor({ name: 'source', process: [{ type: 'Quick Setting Operator', args: { udp: 'ENABLED', tfo: 'DISABLED', extra: 9 } }] });
  await choose('UDP', '沿用来源'); await choose('TCP Fast Open', '启用');
  expect(saved.process?.[0].args).toEqual({ udp: 'DEFAULT', tfo: 'ENABLED', extra: 9 });
});
it.each(['地区筛选', '协议筛选', '重复节点处理', '旗标处理', '快捷参数', '过滤无效信息'])('常用入口可以添加%s并生成独立参数对象', async label => {
  await editor({ name: 'source', process: [] });
  await choose('新增处理器类型', label); await click(button('添加处理器'));
  expect(saved.process).toHaveLength(1); expect(saved.process?.[0].disabled).toBe(false);
});
it('文件处理器列表只提供适用于文本文件的处理', async () => {
  await editor({ name: 'file', process: [] }, 'file');
  await click(host.querySelector('[aria-label="新增处理器类型"]')!);
  expect([...document.querySelectorAll('[role="option"]')].map(element => element.textContent?.trim())).toEqual(['脚本处理', '响应脚本']);
});

const original = [
  { id: 0, name: '香港 01', type: 'ss', server: 'hk.example.invalid', port: 443 },
  { id: 1, name: '日本 02', type: 'trojan', server: 'jp.example.invalid', port: 443 },
  { id: 2, name: '美国 03', type: 'ss', server: 'us.example.invalid', port: 443 },
];
const preview = async (value: unknown) => act(async () => root.render(<PreviewResults value={value} />));
it('预览以引擎id比较，排序和改名不被误判为过滤', async () => {
  await preview({ original, processed: [{ ...original[1], name: 'JP renamed', udp: true }, original[0]] });
  await click(button('被过滤'));
  expect(host.querySelector('.ss-preview-list')?.textContent).toContain('美国 03');
  expect(host.querySelector('.ss-preview-list')?.textContent).not.toContain('日本 02');
  await click(button('处理后'));
  expect(host.querySelector('.ss-preview-list')?.textContent).toContain('日本 02 → JP renamed');
  expect(host.querySelector('.ss-preview-list')?.textContent).toContain('udp');
});
it.each([
  { processed: [{ name: 'renamed', type: 'ss' }] },
  { processed: [{ ...original[0] }, { ...original[1], id: 0 }] },
])('脚本移除或复用id时不猜测过滤结果', async ({ processed }) => {
  await preview({ original, processed });
  expect(button('被过滤'), '被过滤视图入口应存在').toBeTruthy();
  expect(button('被过滤').disabled).toBe(true);
  expect(host.textContent).toContain('无法可靠对比');
});
it('预览可按服务器搜索，并区分搜索无结果与引擎没有节点', async () => {
  await preview({ original, processed: original });
  await fill('搜索预览节点', 'JP.EXAMPLE');
  expect(host.querySelector('.ss-preview-list')?.textContent).toContain('日本 02');
  expect(host.querySelector('.ss-preview-list')?.textContent).not.toContain('香港 01');
  await fill('搜索预览节点', 'nothing-matches'); expect(host.textContent).toContain('没有匹配的节点');
  await fill('搜索预览节点', ''); expect(host.querySelector('.ss-preview-list')?.textContent).toContain('香港 01');
});
it('大预览有界呈现，用户能直接访问末尾节点，参数默认不渲染', async () => {
  const nodes = Array.from({ length: 181 }, (_, id) => ({ id, name: `node-${id}`, type: 'ss', server: 'fixture.invalid', password: 'qa-only' }));
  await preview({ original: nodes, processed: nodes });
  expect(host.querySelectorAll('.ss-preview-node').length).toBeLessThan(181);
  expect(host.querySelectorAll('pre')).toHaveLength(0);
  await act(async () => host.querySelector('[aria-label="预览节点列表"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
  expect(host.querySelector('.ss-preview-list')?.textContent).toContain('node-180');
});
it('文件文本预览保持前后切换，不出现节点筛选', async () => {
  await preview({ original: 'before text', processed: 'after text' });
  expect(host.textContent).toContain('after text'); await click(button('处理前')); expect(host.textContent).toContain('before text');
  expect(host.querySelector('[aria-label="搜索预览节点"]')).toBeNull();
});

it('真实界面生成的常用处理参数经过生产引擎预览、保存和导出验证', async () => {
  const evidence = resolve('.cache/sub-store-iteration-20261123'); mkdirSync(evidence, { recursive: true });
  const data = mkdtempSync(`${evidence}/engine-`);
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port; await new Promise<void>(done => reservation.close(() => done()));
  const child = spawn(process.execPath, [resolve('src-tauri/resources/sub-store/sub-store.bundle.cjs')], {
    cwd: data, env: { ...process.env, SUB_STORE_DATA_BASE_PATH: data, SUB_STORE_BACKEND_API_HOST: '127.0.0.1', SUB_STORE_BACKEND_API_PORT: String(port), SUB_STORE_FRONTEND_BACKEND_PATH: '/' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = createWriteStream(`${data}/server.log`); child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  // 使用原生 HTTP 访问引擎；happy-dom 的 fetch 会额外发出浏览器 CORS 预检。
  const http = (route: string, body?: unknown) => new Promise<{ status: number; text: string }>((done, fail) => {
    const request = httpRequest(`http://127.0.0.1:${port}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' } }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; }); response.on('end', () => done({ status: response.statusCode ?? 0, text })); response.on('error', fail);
    });
    request.on('error', fail); request.setTimeout(5000, () => request.destroy(new Error('引擎请求超时'))); request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const call = async (route: string, body?: unknown) => {
    const response = await http(route, body);
    expect(response.status, response.text).toBe(route === '/api/subs' && body !== undefined ? 201 : 200); const result = JSON.parse(response.text); expect(result.status).toBe('success'); return result.data;
  };
  const nodes = [
    { name: '香港 01', type: 'ss', server: 'hk.example.invalid', port: 443, cipher: 'aes-128-gcm', password: 'synthetic-only', udp: true },
    { name: '日本 02', type: 'trojan', server: 'jp.example.invalid', port: 443, password: 'synthetic-only', udp: false },
    { name: '美国 03', type: 'ss', server: 'us.example.invalid', port: 443, cipher: 'aes-128-gcm', password: 'synthetic-only' },
    { name: '香港 重复', type: 'ss', server: 'hk.example.invalid', port: 443, cipher: 'aes-128-gcm', password: 'synthetic-only' },
    { name: '剩余流量 100GB', type: 'ss', server: 'quota.example.invalid', port: 443, cipher: 'aes-128-gcm', password: 'synthetic-only' },
  ];
  const results: unknown[] = [];
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null) throw new Error(`引擎启动失败 ${child.exitCode}`);
      try { ready = (await http('/api/subs')).status === 200; } catch { /* 服务启动中 */ }
      if (ready) break; await new Promise(done => setTimeout(done, 100));
    }
    expect(ready).toBe(true);
    for (const label of ['地区筛选', '协议筛选', '重复节点处理', '旗标处理', '快捷参数', '过滤无效信息']) {
      await editor({ name: `qa-${results.length}`, source: 'local', content: JSON.stringify({ proxies: nodes }), process: [] });
      await choose('新增处理器类型', label); await click(button('添加处理器'));
      if (label === '地区筛选') { await click(host.querySelector('[aria-label="香港"]')!); await click(host.querySelector('[aria-label="日本"]')!); await choose('筛选方式', '保留匹配'); }
      if (label === '协议筛选') { await click(host.querySelector('[aria-label="trojan"]')!); await choose('筛选方式', '保留匹配'); }
      if (label === '重复节点处理') { await choose('重复判定', '服务器与端口'); await choose('重复处理', '保留首个，删除重复'); }
      if (label === '快捷参数') { await choose('UDP', '沿用来源'); await choose('TCP Fast Open', '启用'); }
      const request = structuredClone(saved);
      const result = await call('/api/preview/sub', request);
      expect(result.original).toHaveLength(5);
      if (label === '地区筛选') expect(result.processed.map((node: { name: string }) => node.name)).toEqual(['香港 01', '日本 02', '香港 重复']);
      if (label === '协议筛选') expect(result.processed.map((node: { type: string }) => node.type)).toEqual(['trojan']);
      if (label === '重复节点处理') { expect(result.processed).toHaveLength(4); expect(result.processed.some((node: { name: string }) => node.name === '香港 重复')).toBe(false); }
      if (label === '旗标处理') expect(result.processed[0].name).toBe('🇭🇰 香港 01');
      if (label === '快捷参数') { expect(result.processed[0].udp).toBe(true); expect(result.processed[1].udp).toBe(false); expect(result.processed.every((node: { tfo: boolean }) => node.tfo === true)).toBe(true); }
      if (label === '过滤无效信息') { expect(result.processed).toHaveLength(4); expect(result.processed.some((node: { name: string }) => node.name.includes('流量'))).toBe(false); }
      await call('/api/subs', request); expect((await call(`/api/sub/${request.name}`)).process).toEqual(request.process);
      const output = await http(`/download/${request.name}?target=ClashMeta`);
      expect(output.status).toBe(200); const text = output.text; expect(text).toContain('proxies:');
      results.push({ label, process: request.process, preview: result });
      writeFileSync(`${data}/${request.name}-output.yaml`, text);
    }
    writeFileSync(`${data}/acceptance.json`, JSON.stringify({ engine: '2.44.16', realUiParameters: true, results }, null, 2));
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 3000); await exited; clearTimeout(timer); }
    log.end();
  }
}, 30000);
