// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { SubStorePage } from '../src/pages/SubStore';
import { useViewPreferences } from '../src/store/view-preferences';
import { useApp } from '../src/store/app';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock('../src/components/CodeEditor', () => ({ default: ({ value }: { value: string }) => createElement('textarea', { value, readOnly: true }) }));
let host: HTMLDivElement; let root: Root; let name: string; let serial = 0; let broken: boolean;
let scope: { kind: string; name: string }; let kind: 'sub' | 'collection' | 'file';
let withTrace: boolean; let withProcessor: boolean;
const trace = () => ({ version: 1, chains: [{ scope, steps: [
  { index: 0, type: 'Script Operator', status: 'skipped', skipReason: 'disabled' },
  { index: 1, type: 'Script Operator', name: '规范名称', status: 'failed', durationMs: 4, inputCount: 2 },
  { index: 2, type: 'Script Operator', name: '后续整理', status: 'not-run' },
] }], truncated: false });
const process = [{ type: 'Script Operator', disabled: true, args: { content: '' } }, { type: 'Script Operator', customName: '规范名称', args: { content: 'throw new Error("broken")' } }];
const entry = () => kind === 'file' ? { name, type: 'mihomoConfig', sourceType: 'collection', sourceName: 'nested', process: [] } : kind === 'sub' ? { name, source: 'local', content: 'ss://fixture', process } : { name, subscriptions: ['child'], process: [] };
const child = { id: 'stable-child-id', name: 'child', source: 'local', content: 'ss://fixture', process };
const click = async (text: string) => {
  const button = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === text);
  expect(button, `${text}入口应存在`).toBeTruthy(); await act(async () => button!.click());
};
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); name = `diagnostic-${++serial}`; broken = true; kind = 'sub'; scope = { kind, name }; withTrace = false; withProcessor = true;
  useViewPreferences.getState().setPreference('subStoreTab', kind);
  useApp.setState({ ...useApp.getInitialState(), profiles: [] });
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'sub_store_status') return { phase: 'running', version: '2.44.16' };
    if (command === 'sub_store_preview_prepare') return 'test-preview-id';
    if (command === 'sub_store_preview_cancel') return true;
    const request = (args as { request: { path: string; method: string } }).request;
    const { path } = request;
    if (path.startsWith('/api/preview/')) {
      if (broken) throw 'Sub-Store HTTP 500: ' + JSON.stringify({ status: 'failed', error: { message: '预览失败', details: 'script broke', ...(withProcessor ? { processor: { index: 1, type: 'Script Operator', name: '规范名称', scope } } : {}), ...(withTrace ? { trace: trace() } : {}) } });
      return JSON.stringify({ status: 'success', data: { original: [], processed: [] } });
    }
    if (request.method !== 'GET') throw new Error('预览不应修改持久数据');
    const data = path === '/api/collection/nested' ? { name: 'nested', subscriptions: ['child'], process } : path === '/api/sub/child' ? child : path === '/api/subs' ? kind === 'sub' ? [entry(), child] : [child] : path === '/api/collections' ? kind === 'file' ? [{ name: 'nested', subscriptions: ['child'], process }] : [entry()] : path === '/api/wholeFiles' ? [entry()] : entry();
    return JSON.stringify({ status: 'success', data });
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const open = async () => { await act(async () => root.render(<SubStorePage />)); await click(name); await click('真实预览'); };

it('失败可定位第二个同类处理器，切换面板并将焦点移到准确步骤', async () => {
  await open();
  expect(host.textContent).toContain('第 2 步'); expect(host.textContent).toContain('规范名称');
  await click('定位处理器');
  const target = host.querySelector('[data-processor-index="1"]');
  expect(target?.closest('[hidden]')).toBeNull(); expect(document.activeElement).toBe(target);
  expect(target?.textContent).toContain('script broke');
});
it('编辑流程变化后清除旧定位，防止错指移动后的步骤', async () => {
  await open(); await click('定位处理器');
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="上移处理器 2"]')!.click());
  expect(host.querySelector('[data-processor-failed="true"]')).toBeNull();
  expect([...host.querySelectorAll('button')].some(button => button.textContent === '定位处理器')).toBe(false);
});
it('子来源失败可打开准确来源，组合草稿保留，成功复验清除旧错误', async () => {
  kind = 'collection'; scope = { kind: 'sub', name: 'child' };
  useViewPreferences.getState().setPreference('subStoreTab', kind);
  await open(); await click('打开出错来源');
  expect(host.querySelector<HTMLInputElement>('[aria-label="名称"]')?.value).toBe('child');
  expect(document.activeElement).toBe(host.querySelector('[data-processor-index="1"]'));
  broken = false; await click('真实预览');
  expect(document.body.textContent).toContain('真实处理预览');
  expect(host.querySelector('[data-processor-failed="true"]')).toBeNull();
});

it('诊断打开带id的来源时复用既有未保存草稿', async () => {
  await act(async () => root.render(<SubStorePage />));
  await click('child');
  const input = host.querySelector<HTMLInputElement>('[aria-label="显示名称"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '未保存名称');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="返回列表"]')!.click());
  kind = 'collection'; scope = { kind: 'sub', name: 'child' };
  await click('组合'); await click(name); await click('真实预览'); await click('打开出错来源');
  expect(host.querySelector<HTMLInputElement>('[aria-label="显示名称"]')?.value).toBe('未保存名称');
  expect(host.querySelector('[data-processor-failed="true"]')).toBeNull();
});

it('Mihomo文件依赖组合失败时可打开组合并定位处理器', async () => {
  kind = 'file'; scope = { kind: 'collection', name: 'nested' };
  useViewPreferences.getState().setPreference('subStoreTab', kind);
  await open(); await click('打开出错组合');
  expect(host.querySelector<HTMLInputElement>('[aria-label="名称"]')?.value).toBe('nested');
  expect(document.activeElement).toBe(host.querySelector('[data-processor-index="1"]'));
});

it('失败轨迹可查看及复制，关闭后继续定位，编辑清除旧轨迹', async () => {
  withTrace = true;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  await open(); await click('查看处理步骤');
  expect(document.querySelector('.ss-trace')?.textContent).toContain('后续整理');
  expect(document.querySelector('.ss-trace')?.textContent).toContain('未执行');
  await click('复制内容');
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('not-run'));
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="关闭预览"]')!.click());
  await click('定位处理器');
  expect(document.activeElement).toBe(host.querySelector('[data-processor-index="1"]'));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="上移处理器 2"]')!.click());
  expect(host.textContent).not.toContain('查看处理步骤');
});
it('加载或解析失败只保留已完成轨迹，不依赖伪造的失败步骤入口', async () => {
  withTrace = true; withProcessor = false;
  await open(); expect(host.textContent).toContain('script broke');
  expect(host.textContent).not.toContain('定位处理器');
  await click('查看处理步骤'); expect(document.querySelector('.ss-trace')).not.toBeNull();
});
