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
const success = JSON.stringify({ status: 'success', data: { original: [], processed: [] } });
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); name = `cancel-${++serial}`; reservation = undefined; response = deferred(); cancellation = deferred();
  useViewPreferences.getState().setPreference('subStoreTab', 'sub'); useApp.setState({ ...useApp.getInitialState(), profiles: [] });
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'sub_store_status') return { phase: 'running', version: '2.44.16' };
    if (command === 'sub_store_preview_prepare') return reservation ? reservation.promise : `preview-${serial}`;
    if (command === 'sub_store_preview_cancel') return cancellation.promise;
    const { request } = args as { request: { path: string; method: string; body?: unknown } };
    if (request.path.startsWith('/api/preview/')) return response.promise;
    const entry = { name, source: 'local', content: 'ss://fixture', process: [] };
    return JSON.stringify({ status: 'success', data: request.path === '/api/subs' ? [entry] : request.method === 'PATCH' ? request.body : entry });
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); mounted = true;
});
afterEach(async () => { if (mounted) await act(async () => root.unmount()); response.resolve(success); cancellation.resolve(true); reservation?.resolve('late'); host.remove(); });
async function open() { await act(async () => root.render(<SubStorePage />)); await click(name); await click('真实预览'); }

it('取消等待原生结束才解锁，保留草稿且可重新预览', async () => {
  await open(); await click('取消预览');
  expect(host.textContent).toContain('正在停止预览'); expect(button('保存草稿')?.disabled).toBe(true);
  await act(async () => cancellation.resolve(true));
  expect(button('保存草稿')?.disabled).toBe(true);
  await act(async () => response.reject('SUB_STORE_PREVIEW_CANCELLED'));
  expect(host.textContent).toContain('预览已取消'); expect(host.querySelector<HTMLInputElement>('[aria-label="名称"]')?.value).toBe(name);
  expect(host.querySelector('[role="dialog"]')).toBeNull(); expect(button('真实预览')?.disabled).toBe(false);
  response = deferred(); await click('真实预览'); await act(async () => response.resolve(success));
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('真实处理预览');
});
it('取消和成功响应相遇时忽略旧结果，不弹出预览', async () => {
  await open(); await click('取消预览');
  await act(async () => { response.resolve(success); cancellation.resolve(false); });
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(button('真实预览')?.disabled).toBe(false);
});
it('离开页面会取消预览，重新进入不接受旧响应', async () => {
  await open(); await act(async () => root.unmount()); mounted = false;
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'sub_store_preview_cancel')).toBe(true);
  root = createRoot(host); mounted = true; await act(async () => root.render(<SubStorePage />));
  await act(async () => { cancellation.resolve(true); response.resolve(success); });
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(button('取消预览')).toBeUndefined();
});
it('预览标识尚未返回时取消也会送达，不启动迟到的预览', async () => {
  reservation = deferred(); await open(); await click('取消预览');
  await act(async () => reservation!.resolve('reserved-late'));
  expect(vi.mocked(invoke).mock.calls.some(([command, args]) => command === 'sub_store_preview_cancel' && (args as { id: string }).id === 'reserved-late')).toBe(true);
  await act(async () => cancellation.resolve(true));
  expect(button('真实预览')?.disabled).toBe(false); expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it('取消调用失败仍维持执行状态并允许重试', async () => {
  await open(); await click('取消预览'); await act(async () => cancellation.reject('取消通道暂不可用'));
  expect(host.textContent).toContain('取消通道暂不可用'); expect(button('取消预览')?.disabled).toBe(false); expect(button('保存草稿')?.disabled).toBe(true);
  cancellation = deferred(); await click('取消预览'); await act(async () => { cancellation.resolve(true); response.reject('SUB_STORE_PREVIEW_CANCELLED'); });
  expect(host.textContent).toContain('预览已取消'); expect(button('真实预览')?.disabled).toBe(false);
});

it('准备阶段的取消失败后仍可重试，不丢失任务标识', async () => {
  reservation = deferred(); await open(); await click('取消预览');
  await act(async () => reservation!.resolve('retry-preparing'));
  await act(async () => cancellation.reject('取消通道暂不可用'));
  expect(button('取消预览')?.disabled).toBe(false); expect(button('保存草稿')?.disabled).toBe(true);
  cancellation = deferred(); await click('取消预览');
  await act(async () => { cancellation.resolve(true); response.reject('SUB_STORE_PREVIEW_CANCELLED'); });
  expect(host.textContent).toContain('预览已取消'); expect(button('真实预览')?.disabled).toBe(false);
});
