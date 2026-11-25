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
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
let host: HTMLDivElement; let root: Root; let mounted: boolean; let serial = 0; let name: string;
let response: ReturnType<typeof deferred<string>>; let cancellation: ReturnType<typeof deferred<boolean>>;
let reservation: ReturnType<typeof deferred<string>> | undefined;
const button = (text: string) => [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === text);
const click = async (text: string) => { expect(button(text), `${text}入口应存在`).toBeTruthy(); await act(async () => button(text)!.click()); };
const output = 'proxies:\n  - name: Exported\n    type: direct\n';
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); name = `export-${++serial}`; reservation = undefined; response = deferred(); cancellation = deferred();
  useViewPreferences.getState().setPreference('subStoreTab', 'sub');
  useApp.setState({ ...useApp.getInitialState(), profiles: [] });
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'sub_store_status') return { phase: 'running', version: '2.44.16' };
    if (command === 'sub_store_preview_prepare') return reservation ? reservation.promise : `export-job-${serial}`;
    if (command === 'sub_store_preview_cancel') return cancellation.promise;
    const { request } = args as { request: { path: string; method: string; body?: unknown } };
    if (request.path.startsWith('/download/') || request.path.startsWith('/api/file/')) return response.promise;
    const entry = { name, source: 'local', content: 'ss://fixture', process: [] };
    const list = ['/api/subs', '/api/collections', '/api/wholeFiles'].includes(request.path);
    return JSON.stringify({ status: 'success', data: list ? [entry] : request.method === 'PATCH' ? request.body : entry });
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); mounted = true;
});
afterEach(async () => { if (mounted) await act(async () => root.unmount()); response.resolve(output); cancellation.resolve(true); reservation?.resolve('late'); host.remove(); });
async function open() { await act(async () => root.render(<SubStorePage />)); await click('导出'); }

it('导出取消确认结束前保持锁定，完成后可以重新导出和保存完整结果', async () => {
  await open(); await click('取消导出');
  expect(host.textContent).toContain('正在停止导出'); expect(button('导出')?.disabled).toBe(true);
  await act(async () => cancellation.resolve(true)); expect(button('导出')?.disabled).toBe(true);
  await act(async () => response.reject('SUB_STORE_PREVIEW_CANCELLED'));
  expect(host.textContent).toContain('导出已取消'); expect(button('导出')?.disabled).toBe(false);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  response = deferred(); await click('导出'); await act(async () => response.resolve(output));
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(output);
  expect(button('保存文件')?.disabled).toBe(false);
});

it('取消与成功响应相遇时不打开可保存的迟到结果', async () => {
  await open(); await click('取消导出');
  await act(async () => { response.resolve(output); cancellation.resolve(false); });
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(button('导出')?.disabled).toBe(false);
});

it('离页取消导出，重新进入不接受旧结果', async () => {
  await open(); await act(async () => root.unmount()); mounted = false;
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'sub_store_preview_cancel')).toBe(true);
  root = createRoot(host); mounted = true; await act(async () => root.render(<SubStorePage />));
  await act(async () => { cancellation.resolve(true); response.resolve(output); });
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(button('取消导出')).toBeUndefined();
});

it('准备期间取消不会启动迟到的生成请求', async () => {
  reservation = deferred(); await open(); await click('取消导出');
  await act(async () => reservation!.resolve('reserved-export'));
  await act(async () => cancellation.resolve(true));
  expect(button('导出')?.disabled).toBe(false); expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'sub_store_preview')).toHaveLength(0);
});

it.each([false, true])('取消通道失败仍可重试，保留生成句柄（准备期：%s）', async preparing => {
  if (preparing) reservation = deferred();
  await open(); await click('取消导出');
  if (preparing) await act(async () => reservation!.resolve('retry-export'));
  await act(async () => cancellation.reject('取消通道暂不可用'));
  expect(host.textContent).toContain('取消通道暂不可用'); expect(button('取消导出')?.disabled).toBe(false); expect(button('导出')?.disabled).toBe(true);
  cancellation = deferred(); await click('取消导出');
  await act(async () => { cancellation.resolve(true); response.reject('SUB_STORE_PREVIEW_CANCELLED'); });
  expect(host.textContent).toContain('导出已取消'); expect(button('导出')?.disabled).toBe(false);
});

it.each(['sub', 'collection', 'file'] as const)('来源类型 %s 的导出走隔离任务且保留原始文本', async kind => {
  useViewPreferences.getState().setPreference('subStoreTab', kind); await open();
  const path = kind === 'file' ? `/api/file/${name}?target=ClashMeta` : `/download/${kind === 'collection' ? 'collection/' : ''}${name}?target=ClashMeta`;
  expect(invoke).toHaveBeenCalledWith('sub_store_preview', { id: `export-job-${serial}`, request: { path, method: 'GET' } });
  const text = '{"proxies":[],"mode":"rule"}'; await act(async () => response.resolve(text));
  expect(document.querySelector('[role="dialog"] pre')?.textContent).toBe(text);
});

it('导出失败后解除锁定并展示真实原因，可以重试', async () => {
  await open(); await act(async () => response.reject('合成来源下载失败'));
  expect(host.textContent).toContain('合成来源下载失败'); expect(button('导出')?.disabled).toBe(false); expect(button('取消导出')).toBeUndefined();
  response = deferred(); await click('导出'); await act(async () => response.resolve(output));
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(output);
});

it('既有加入应用流程在离页后仍完成导入，不被导出取消逻辑丢弃', async () => {
  const addProfile = vi.fn().mockResolvedValue(undefined);
  useApp.setState({ addSubStoreProfile: addProfile });
  await act(async () => root.render(<SubStorePage />)); await click('加入应用');
  await act(async () => root.unmount()); mounted = false;
  await act(async () => response.resolve(output));
  expect(addProfile).toHaveBeenCalledWith(name, { kind: 'sub', name }, output);
});

it('导出期间不丢失列表中可恢复的未保存草稿', async () => {
  await act(async () => root.render(<SubStorePage />)); await click(name);
  const input = host.querySelector<HTMLInputElement>('[aria-label="备注"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '未保存的备注'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="返回列表"]')!.click());
  await click('导出'); await click('取消导出');
  await act(async () => { cancellation.resolve(true); response.reject('SUB_STORE_PREVIEW_CANCELLED'); });
  await click(`恢复草稿 · ${name}`);
  expect(host.querySelector<HTMLInputElement>('[aria-label="备注"]')?.value).toBe('未保存的备注'); expect(button('保存草稿')?.disabled).toBe(false);
});
