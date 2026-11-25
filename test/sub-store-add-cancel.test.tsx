// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { api } from '../src/core/api';
import { SubStorePage } from '../src/pages/SubStore';
import { useViewPreferences } from '../src/store/view-preferences';
import { useApp } from '../src/store/app';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, isTauri: true, api: Object.fromEntries(Object.keys(actual.api).map(key => [key, vi.fn()])) };
});
vi.mock('../src/components/CodeEditor', () => ({ default: ({ value }: { value: string }) => createElement('textarea', { value, readOnly: true }) }));
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
let host: HTMLDivElement; let root: Root; let mounted: boolean; let serial = 0; let name: string;
let response: ReturnType<typeof deferred<string>>; let cancellation: ReturnType<typeof deferred<boolean>>;
let reservation: ReturnType<typeof deferred<string>> | undefined;
const button = (text: string) => [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === text);
const click = async (text: string) => { expect(button(text), `${text}入口应存在`).toBeTruthy(); await act(async () => button(text)!.click()); };
const output = JSON.stringify({ proxies: [{ name: 'fixture', type: 'socks5', server: 'fixture.invalid', port: 1080 }],
  'proxy-groups': [{ name: 'Main', type: 'select', proxies: ['fixture'] }], rules: ['MATCH,Main'] });
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks(); name = `add-${++serial}`; reservation = undefined; response = deferred(); cancellation = deferred();
  useViewPreferences.getState().setPreference('subStoreTab', 'sub');
  const initial = useApp.getInitialState();
  useApp.setState({ ...initial, profiles: [], activeId: null, notify: vi.fn(), persistenceSession: `add-session-${serial}`,
    settings: { ...initial.settings, egressGuard: false } });
  vi.mocked(api.prepareConfig).mockResolvedValue('/isolated/candidate.yaml');
  vi.mocked(api.validateConfig).mockResolvedValue(undefined);
  vi.mocked(api.discardConfig).mockResolvedValue(undefined);
  vi.mocked(api.saveAppState).mockResolvedValue(undefined);
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'sub_store_status') return { phase: 'running', version: '2.44.16' };
    if (command === 'sub_store_preview_prepare') return reservation ? reservation.promise : `add-job-${serial}`;
    if (command === 'sub_store_preview_cancel') return cancellation.promise;
    const { request } = args as { request: { path: string; method: string; body?: unknown } };
    if (request.path.startsWith('/download/')) return response.promise;
    const entry = { name, displayName: `显示 ${name}`, source: 'local', content: 'ss://fixture', process: [] };
    return JSON.stringify({ status: 'success', data: ['/api/subs', '/api/collections'].includes(request.path) ? [entry] : entry });
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); mounted = true;
});
afterEach(async () => { if (mounted) await act(async () => root.unmount()); cancellation.resolve(true); reservation?.resolve('late'); host.remove(); });
async function open() { await act(async () => root.render(<SubStorePage />)); await click('加入应用'); }
async function leave() { await act(async () => root.unmount()); mounted = false; }
function noImport() { expect(useApp.getState().profiles).toEqual([]); expect(api.prepareConfig).not.toHaveBeenCalled(); expect(api.saveAppState).not.toHaveBeenCalled(); }

it('取消后等待生成结束再解锁，保留真实订阅库且可以重新加入', async () => {
  await open(); await click('取消生成');
  expect(host.textContent).toContain('正在停止生成'); expect(button('加入应用')?.disabled).toBe(true);
  await act(async () => cancellation.resolve(true)); expect(button('加入应用')?.disabled).toBe(true); noImport();
  await act(async () => response.reject('SUB_STORE_PREVIEW_CANCELLED'));
  expect(host.textContent).toContain('生成已取消'); expect(button('加入应用')?.disabled).toBe(false); noImport();
  response = deferred(); await click('加入应用'); await act(async () => response.resolve(output));
  expect(useApp.getState().profiles).toHaveLength(1); expect(api.saveAppState).toHaveBeenCalled();
  expect(host.textContent).toContain('已加入应用订阅');
});

it('准备阶段取消不执行迟到的生成，也不创建订阅', async () => {
  reservation = deferred(); await open(); await click('取消生成');
  await act(async () => reservation!.resolve('reserved-add'));
  await act(async () => cancellation.resolve(true));
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'sub_store_preview')).toHaveLength(0);
  expect(button('加入应用')?.disabled).toBe(false); noImport();
});

it.each([false, true])('取消发送失败可重试，结束前不能重复加入（准备期：%s）', async preparing => {
  if (preparing) reservation = deferred();
  await open(); await click('取消生成');
  if (preparing) await act(async () => reservation!.resolve('retry-add'));
  await act(async () => cancellation.reject('取消通道暂不可用'));
  expect(host.textContent).toContain('取消通道暂不可用'); expect(button('取消生成')?.disabled).toBe(false);
  expect(button('加入应用')?.disabled).toBe(true); noImport();
  cancellation = deferred(); await click('取消生成');
  await act(async () => { cancellation.resolve(true); response.reject('SUB_STORE_PREVIEW_CANCELLED'); });
  expect(button('加入应用')?.disabled).toBe(false); noImport();
});

it.each([false, true])('取消与成功相遇时忽略输出，不进入校验或持久化（离页：%s）', async unmount => {
  await open(); await click('取消生成'); if (unmount) await leave();
  await act(async () => { response.resolve(output); cancellation.resolve(false); });
  noImport();
});

it.each(['sub', 'collection'] as const)('%s 通过隔离生成 ClashMeta，并保存实际来源关联', async kind => {
  useViewPreferences.getState().setPreference('subStoreTab', kind); await open();
  expect(invoke).toHaveBeenCalledWith('sub_store_preview', { id: `add-job-${serial}`,
    request: { path: `/download/${kind === 'collection' ? 'collection/' : ''}${name}?target=ClashMeta`, method: 'GET' } });
  await act(async () => response.resolve(output));
  expect(useApp.getState().profiles).toHaveLength(1);
  expect(useApp.getState().profiles[0]).toMatchObject({ name: `显示 ${name}`, raw: output, sourceType: 'substore', subStore: { kind, name } });
  expect(api.saveAppState).toHaveBeenCalled(); expect(api.startKernel).not.toHaveBeenCalled(); expect(api.commitConfig).not.toHaveBeenCalled();
  expect(useApp.getState().activeId).toBeNull(); expect(button('取消生成')).toBeUndefined();
});

it('进入校验和保存后收起取消入口，写入成功前保持操作锁且不报告成功', async () => {
  const validation = deferred<void>(); const saving = deferred<void>();
  vi.mocked(api.validateConfig).mockReturnValue(validation.promise); vi.mocked(api.saveAppState).mockReturnValue(saving.promise);
  await open(); await act(async () => response.resolve(output));
  expect(host.textContent).toContain('正在校验并保存订阅'); expect(button('取消生成')).toBeUndefined();
  expect(button('加入应用')?.disabled).toBe(true); expect(api.saveAppState).not.toHaveBeenCalled();
  await act(async () => validation.resolve());
  expect(api.saveAppState).toHaveBeenCalled(); expect(host.textContent).not.toContain('已加入应用订阅');
  expect(button('导出')?.disabled).toBe(true); expect(button('取消生成')).toBeUndefined();
  await act(async () => saving.resolve()); expect(host.textContent).toContain('已加入应用订阅');
});

it('生成期间离页不发送取消，重进页面后旧任务仍完成一次持久化', async () => {
  await open(); await leave(); root = createRoot(host); mounted = true;
  await act(async () => root.render(<SubStorePage />));
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'sub_store_preview_cancel')).toHaveLength(0);
  await act(async () => response.resolve(output));
  expect(useApp.getState().profiles).toHaveLength(1); expect(api.saveAppState).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('已加入应用'); expect(button('加入应用')?.disabled).toBe(true); expect(button('取消生成')).toBeUndefined();
});

it.each(['generation', 'empty', 'validation', 'persistence'] as const)('%s 失败显示原因且不留下订阅，重试可以成功', async stage => {
  if (stage === 'validation') vi.mocked(api.validateConfig).mockRejectedValueOnce(new Error('合成校验失败'));
  if (stage === 'persistence') vi.mocked(api.saveAppState).mockRejectedValueOnce(new Error('合成保存失败'));
  await open();
  await act(async () => { if (stage === 'generation') response.reject('合成生成失败'); else response.resolve(stage === 'empty' ? '' : output); });
  expect(host.textContent).toContain(stage === 'empty' ? '后端没有返回可用的订阅内容' : '合成');
  expect(host.textContent).not.toContain('已加入应用订阅'); expect(useApp.getState().profiles).toEqual([]);
  expect(button('取消生成')).toBeUndefined(); expect(button('加入应用')?.disabled).toBe(false);
  response = deferred(); await click('加入应用'); await act(async () => response.resolve(output));
  expect(host.textContent).toContain('已加入应用订阅'); expect(useApp.getState().profiles).toHaveLength(1);
});
