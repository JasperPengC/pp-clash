// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { PreviewResults } from '../src/components/sub-store/PreviewResults';
import { SubStorePage } from '../src/pages/SubStore';
import { useApp } from '../src/store/app';
import { useViewPreferences } from '../src/store/view-preferences';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock('../src/components/CodeEditor', () => ({ default: ({ value }: { value: string }) => createElement('textarea', { value, readOnly: true }) }));
let host: HTMLDivElement; let root: Root;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useApp.setState(useApp.getInitialState(), true);
  useViewPreferences.setState(useViewPreferences.getInitialState(), true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const nodes = (count: number) => Array.from({ length: count }, (_, id) => ({ id, name: `node-${id}`, server: `server-${id}.invalid`, port: 443, type: 'ss', password: `qa-${id}` }));
const render = async (value: unknown) => act(async () => root.render(<PreviewResults value={value} />));
const click = async (label: string, within: ParentNode = document) => {
  const button = [...within.querySelectorAll('button')].find(item => item.textContent?.trim() === label || item.getAttribute('aria-label') === label);
  expect(button, `${label}入口应存在`).toBeTruthy(); await act(async () => button!.click());
};
const fill = async (label: string, value: string) => act(async () => {
  const input = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  expect(input).toBeTruthy(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
const viewport = () => host.querySelector<HTMLElement>('[aria-label="预览节点列表"]')!;
const end = async () => {
  expect(viewport(), '节点列表应可键盘访问').toBeTruthy();
  await act(async () => viewport().dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
};

it('万级节点在末尾和重复滚动后保持有界，详情返回保留位置和焦点', async () => {
  const data = nodes(10000); await render({ original: data, processed: data });
  expect(host.querySelectorAll('pre')).toHaveLength(0);
  for (let i = 0; i < 3; i++) {
    await end(); expect(viewport().textContent).toContain('node-9999');
    expect(viewport().querySelectorAll('[role="listitem"]').length).toBeLessThanOrEqual(30);
    expect(host.querySelectorAll('*').length).toBeLessThan(600);
  }
  const offset = viewport().scrollTop;
  await click('查看节点 node-9999 详情');
  expect(host.querySelector('[aria-label="节点详情"]')?.textContent).toContain('qa-9999');
  expect(document.activeElement?.textContent).toBe('返回节点列表');
  await click('返回节点列表');
  expect(viewport().scrollTop).toBe(offset);
  expect(document.activeElement?.getAttribute('aria-label')).toBe('查看节点 node-9999 详情');
});

it('全部四个节点视图支持末尾访问，搜索和切换清除旧详情并复位', async () => {
  const original = nodes(10000); const processed = original.slice(0, 9000).map(node => ({ ...node, name: `new-${node.id}` }));
  await render({ original, processed }); await end(); await click('查看节点 new-8999 详情');
  await fill('搜索预览节点', 'server-22.invalid');
  expect(host.querySelector('[aria-label="节点详情"]')).toBeNull();
  expect(viewport().querySelectorAll('[role="listitem"]')).toHaveLength(1);
  expect(viewport().textContent).toContain('new-22'); expect(viewport().scrollTop).toBe(0);
  await fill('搜索预览节点', ''); expect(viewport().textContent).toContain('new-0');
  for (const [view, last] of [['处理前', 'node-9999'], ['被过滤', 'node-9999'], ['差异', 'node-9999']] as const) {
    await click(view); expect(viewport().scrollTop).toBe(0); await end();
    expect(viewport().textContent).toContain(last); expect(viewport().querySelectorAll('[role="listitem"]').length).toBeLessThanOrEqual(30);
  }
});

it.each([undefined, 'duplicate'])('缺失或重复id的同名节点不复用别人的详情：%s', async id => {
  const data = [{ id, name: '同名', server: 'first.invalid', password: 'FIRST' }, { id, name: '同名', server: 'second.invalid', password: 'SECOND' }];
  await render({ original: data, processed: data });
  await click('查看节点 同名 详情'); expect(host.querySelector('[aria-label="节点详情"]')?.textContent).toContain('FIRST');
  await fill('搜索预览节点', 'second.invalid'); expect(host.querySelector('[aria-label="节点详情"]')).toBeNull();
  await click('查看节点 同名 详情');
  const detail = host.querySelector('[aria-label="节点详情"]')!;
  expect(detail.textContent).toContain('SECOND'); expect(detail.textContent).not.toContain('FIRST');
  await click('处理前'); expect(host.querySelector('[aria-label="节点详情"]')).toBeNull();
});

it('结果对象替换后不保留旧详情或滚动窗口', async () => {
  const data = nodes(10000); await render({ original: data, processed: data }); await end(); await click('查看节点 node-9999 详情');
  const replacement = [{ ...data[0], name: 'replacement' }]; await render({ original: replacement, processed: replacement });
  expect(host.querySelector('[aria-label="节点详情"]')).toBeNull();
  expect(viewport().textContent).toContain('replacement'); expect(viewport().scrollTop).toBe(0);
});

it('完整JSON按段展示且拼接无丢字，关闭展开可重新阅读', async () => {
  const value = { original: [], processed: [], extra: '合成文本'.repeat(13000) + '😀末尾' };
  await render(value);
  const raw = host.querySelector<HTMLDetailsElement>('.ss-preview-raw')!;
  await act(async () => { raw.open = true; raw.dispatchEvent(new Event('toggle')); });
  let combined = '';
  for (let i = 0; i < 10; i++) {
    const text = raw.querySelector('pre')?.textContent ?? '';
    expect(text.length).toBeLessThanOrEqual(16001); combined += text;
    const next = [...raw.querySelectorAll('button')].find(button => button.textContent === '下一段');
    if (!next || next.disabled) break;
    await act(async () => next.click());
  }
  expect(combined).toBe(JSON.stringify(value, null, 2));
  await act(async () => { raw.open = false; raw.dispatchEvent(new Event('toggle')); }); expect(raw.querySelector('pre')).toBeNull();
  await act(async () => { raw.open = true; raw.dispatchEvent(new Event('toggle')); }); expect(raw.querySelector('pre')?.textContent?.startsWith('{')).toBe(true);
});

it('超长文件文本保持字符与emoji完整，并能直接跳到末段', async () => {
  const text = 'a'.repeat(15999) + '😀' + 'b'.repeat(17000) + '尾部'; await render({ original: '旧文本', processed: text });
  const block = host.querySelector('[aria-label="处理后文本"]')!;
  expect(block, '文本预览应分段').toBeTruthy();
  const parts = [block.querySelector('pre')!.textContent]; await click('下一段', block); parts.push(block.querySelector('pre')!.textContent);
  await fill('处理后文本段落', '3'); parts.push(block.querySelector('pre')!.textContent);
  expect(parts.join('')).toBe(text);
  await click('处理前'); expect(host.textContent).toContain('旧文本');
});

it('长文本切段和跳段都从新段顶部开始，避免继承旧滚动位置', async () => {
  await render({ original: '', processed: 'a\n'.repeat(24000) });
  const block = host.querySelector('[aria-label="处理后文本"]')!;
  block.querySelector('pre')!.scrollTop = 2000;
  await click('下一段', block); expect(block.querySelector('pre')!.scrollTop).toBe(0);
  block.querySelector('pre')!.scrollTop = 1000;
  await fill('处理后文本段落', '3'); expect(block.querySelector('pre')!.scrollTop).toBe(0);
});

it('成功预览不提前序列化，搜索和跳到末尾之后复制仍包含全部万级原始结果', async () => {
  const data = nodes(10000); const payload = { original: data, processed: data, trace: { version: 1, chains: [], truncated: false } };
  const entry = { name: 'budget-copy', source: 'local', content: 'ss://qa-only', process: [] };
  const response = JSON.stringify({ status: 'success', data: payload });
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'sub_store_status') return { phase: 'running', version: '2.44.16' };
    if (command === 'sub_store_preview_prepare') return 'test-preview-id';
    if (command === 'sub_store_preview_cancel') return true;
    const { path, method } = (args as { request: { path: string; method: string } }).request;
    if (path === '/api/preview/sub' && method === 'POST') return response;
    if (method !== 'GET') throw new Error('预览不应修改持久数据');
    return JSON.stringify({ status: 'success', data: path === '/api/subs' ? [entry] : entry });
  });
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const stringify = vi.spyOn(JSON, 'stringify');
  await act(async () => root.render(<SubStorePage />)); await click('budget-copy'); await click('真实预览');
  expect(stringify.mock.calls.filter(([value]) => value?.original?.length === 10000 && value?.processed?.length === 10000)).toHaveLength(0);
  const list = document.querySelector('[aria-label="预览节点列表"]')!;
  await act(async () => list.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
  expect(list.textContent).toContain('node-9999');
  await fill('搜索预览节点', 'node-9999'); await click('复制内容');
  expect(writeText).toHaveBeenCalledTimes(1);
  const copied = JSON.parse(writeText.mock.calls[0][0]);
  expect(copied.original).toHaveLength(10000); expect(copied.processed).toHaveLength(10000);
  expect(copied.processed[0].name).toBe('node-0'); expect(copied.processed[9999].name).toBe('node-9999'); expect(copied.trace).toEqual(payload.trace);
});
