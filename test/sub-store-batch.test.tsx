// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { SubStorePage } from '../src/pages/SubStore';
import { useViewPreferences } from '../src/store/view-preferences';
import { useApp } from '../src/store/app';
import type { Entry, Tab } from '../src/components/sub-store/model';
import { startTestSubStore } from './helpers/sub-store-engine';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
const platform = vi.hoisted(() => ({ android: false }));
vi.mock('../src/core/platform', () => ({ get isAndroid() { return platform.android; } }));
vi.mock('../src/components/CodeEditor', () => ({ default: ({ value }: { value: string }) => createElement('textarea', { value, readOnly: true }) }));
let root: Root; let host: HTMLDivElement; let mounted: boolean;
let data: Record<string, Entry[]>; let calls: string[]; let failures: Set<string>;
let hold: { promise: Promise<void>; resolve: () => void } | undefined;
let responseData: unknown;
const routes: Record<Tab, string> = { sub: '/api/subs', collection: '/api/collections', file: '/api/wholeFiles', artifact: '/api/artifacts', share: '/api/tokens', archive: '/api/archives' };
const button = (text: string) => [...document.querySelectorAll('button')].find(el => el.textContent?.trim() === text);
async function click(el: HTMLElement | undefined | null) { expect(el, '操作入口应存在').toBeTruthy(); await act(async () => el!.click()); }
const check = (name: string) => host.querySelector<HTMLInputElement>(`[aria-label="选择 ${name}"]`);
async function open(tab: Tab = 'sub', batch = true) { useViewPreferences.getState().setPreference('subStoreTab', tab); await act(async () => root.render(<SubStorePage />)); if (batch && button('批量操作')) await click(button('批量操作')); }
async function selectAll() { if (!host.querySelector('[aria-label="选择当前搜索结果"]') && button('批量操作')) await click(button('批量操作')); await click(host.querySelector('[aria-label="选择当前搜索结果"]')); }
async function archive() { await click(button('归档选中')); await click(button('确认归档')); }
async function search(value: string) { await act(async () => { const el = host.querySelector<HTMLInputElement>('[aria-label="搜索 Sub-Store"]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); }); }
beforeEach(() => {
  platform.android = false;
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); useViewPreferences.setState({ queries: [] }); useApp.setState({ ...useApp.getInitialState(), profiles: [] });
  calls = []; failures = new Set(); hold = undefined; responseData = {};
  data = { '/api/subs': [{ name: 'A', source: 'local', content: 'ss://fixture' }, { name: 'B', source: 'local', content: 'ss://fixture' }, { name: 'C', source: 'local', content: 'ss://fixture' }], '/api/collections': [], '/api/wholeFiles': [], '/api/artifacts': [], '/api/tokens': [], '/api/archives': [] };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'sub_store_status') return { phase: 'running', version: '2.44.16' };
    const { request: r } = args as { request: { path: string; method: string } };
    if (r.method === 'GET' && data[r.path]) { if (failures.has(r.path)) throw '引用读取失败'; return JSON.stringify({ status: 'success', data: data[r.path] }); }
    calls.push(`${r.method} ${r.path}`);
    if (hold) await hold.promise;
    if (failures.has(r.path)) throw new Error('合成条目失败');
    if (r.method === 'DELETE') {
      const url = new URL(r.path, 'http://test'); const [, , kind, encoded] = url.pathname.split('/'); const name = decodeURIComponent(encoded);
      const path = kind === 'token' ? '/api/tokens' : routes[kind as Tab];
      data[path] = data[path].filter(e => kind === 'token' ? !(e.token === name && e.type === url.searchParams.get('type') && e.name === url.searchParams.get('name')) : e.name !== name);
    }
    if (r.method === 'POST') data['/api/archives'] = data['/api/archives'].filter(e => !r.path.includes(encodeURIComponent(String(e.id))));
    return JSON.stringify({ status: 'success', data: responseData });
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); mounted = true;
});
afterEach(async () => { if (mounted) await act(async () => root.unmount()); hold?.resolve(); host.remove(); });

// 保护选择范围：按当前搜索结果全选，改变搜索或分类后不能误操作旧选择。
it('Android读取已启动的原生后端并显示来源列表', async () => {
  platform.android = true;
  await open('sub', false);
  expect(invoke).toHaveBeenCalledWith('sub_store_status');
  expect(host.textContent).toContain('后端运行中');
  expect(host.textContent).toContain('A');
  expect(host.textContent).not.toContain('暂不支持');
});
it('默认只浏览列表，进入批量操作才显示选择框，完成后清空选择', async () => {
  await open('sub', false);
  expect(check('A')).toBeNull();
  expect(host.querySelector('[aria-label="选择当前搜索结果"]')).toBeNull();
  await click(button('批量操作'));
  await click(check('A'));
  expect(host.querySelector<HTMLInputElement>('[aria-label="选择当前搜索结果"]')?.indeterminate).toBe(true);
  await click(button('完成'));
  expect(check('A')).toBeNull();
  await click(button('批量操作'));
  expect(check('A')?.checked).toBe(false);
  expect(calls).toEqual([]);
});
it('空列表不显示无效的批量选择栏或其他分类的说明', async () => {
  data['/api/subs'] = [];
  await open('sub', false);
  expect(host.querySelector('[aria-label="选择当前搜索结果"]')).toBeNull();
  expect(button('归档选中')).toBeUndefined();
  await click(button('分享'));
  expect(host.textContent).not.toContain('保存来源与处理器后');
  expect(host.querySelector('[aria-label="选择当前搜索结果"]')).toBeNull();
});
it('全选只作用于当前搜索结果，改变筛选和分类清空选择', async () => {
  await open(); await click(check('A')); expect(host.querySelector<HTMLInputElement>('[aria-label="选择当前搜索结果"]')?.indeterminate).toBe(true);
  await search('B'); expect(button('归档选中')?.disabled).toBe(true); await selectAll(); await archive();
  expect(calls).toEqual(['DELETE /api/sub/B?mode=archive']); expect(data['/api/subs'].map(e => e.name)).toEqual(['A', 'C']);
  await search(''); await click(check('A')); await click(button('组合')); expect(button('归档选中')).toBeUndefined();
});
it('批量归档前列出组合、文件、同步和应用引用，确认前不写入', async () => {
  data['/api/collections'] = [{ name: '依赖组合', subscriptions: ['A'] }];
  data['/api/wholeFiles'] = [{ name: '依赖文件', type: 'mihomoConfig', sourceType: 'subscription', sourceName: 'A' }];
  data['/api/artifacts'] = [{ name: '依赖同步', type: 'subscription', source: 'A' }];
  useApp.setState({ profiles: [{ id: 'qa', name: '应用引用', subStore: { kind: 'sub', name: 'A' } }] as ReturnType<typeof useApp.getState>['profiles'] });
  await open(); await click(check('A')); await click(button('归档选中'));
  const dialog = document.querySelector('[role="dialog"]')!;
  for (const text of ['依赖组合', '依赖文件', '依赖同步', '应用引用']) expect(dialog.textContent).toContain(text);
  expect(calls).toEqual([]); await click(button('取消')); expect(calls).toEqual([]); expect(check('A')?.checked).toBe(true);
});
it('引用读取失败阻止批量归档，不把检查失败当作无引用', async () => {
  failures.add('/api/collections'); await open(); await click(check('A')); await click(button('归档选中'));
  expect(host.textContent).toContain('引用读取失败'); expect(button('确认归档')).toBeUndefined(); expect(calls).toEqual([]);
});
it('归档提示包含文件处理器的默认来源引用，忽略禁用处理器', async () => {
  data['/api/wholeFiles'] = [
    { name: '处理器引用文件', type: 'mihomoConfig', sourceType: 'none', process: [{ type: 'Add Proxies From Subscription Operator', args: { sourceName: 'A' } }] },
    { name: '已禁用引用文件', type: 'mihomoConfig', sourceType: 'none', process: [{ type: 'Add Proxies From Subscription Operator', args: { sourceName: 'A' }, disabled: true }] },
  ];
  await open(); await click(check('A')); await click(button('归档选中'));
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('处理器引用文件');
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('已禁用引用文件');
});
it('归档组合时识别旧文件默认组合来源及显式处理器组合来源', async () => {
  data['/api/collections'] = [{ name: 'collection-A', subscriptions: ['A'] }];
  data['/api/wholeFiles'] = [
    { name: '旧版默认组合文件', type: 'mihomoConfig', sourceName: 'collection-A', process: [] },
    { name: '处理器组合文件', type: 'mihomoConfig', sourceType: 'none', process: [{ type: 'Add Proxies From Subscription Operator', args: { sourceType: 'collection', sourceName: 'collection-A' } }] },
  ];
  await open('collection'); await selectAll(); await click(button('归档选中'));
  for (const name of ['旧版默认组合文件', '处理器组合文件']) expect(document.querySelector('[role="dialog"]')?.textContent).toContain(name);
});
it('部分失败继续处理其他条目，成功项取消选择且重试只请求失败项', async () => {
  failures.add('/api/sub/B?mode=archive'); await open(); await selectAll(); await archive();
  expect(calls).toHaveLength(3); expect(host.textContent).toContain('成功 2'); expect(host.textContent).toContain('失败 1'); expect(host.textContent).toContain('合成条目失败');
  expect(check('B')?.checked).toBe(true); failures.clear(); await archive();
  expect(calls).toEqual(['DELETE /api/sub/A?mode=archive', 'DELETE /api/sub/B?mode=archive', 'DELETE /api/sub/C?mode=archive', 'DELETE /api/sub/B?mode=archive']);
});
it('停止后续任务等待当前归档完成，剩余项保持选中且不派发', async () => {
  let resolve!: () => void; hold = { promise: new Promise<void>(yes => { resolve = yes; }), resolve: () => resolve() };
  await open(); await selectAll(); await archive(); await click(button('停止后续任务'));
  expect(button('停止后续任务')?.disabled).toBe(true); expect(check('B')?.disabled).toBe(true); expect(calls).toHaveLength(1);
  await act(async () => hold!.resolve()); expect(calls).toHaveLength(1); expect(check('B')?.checked).toBe(true); expect(check('C')?.checked).toBe(true); expect(host.textContent).toContain('未执行 2');
});
it('离页停止后续派发，当前完成后不污染新页面', async () => {
  let resolve!: () => void; hold = { promise: new Promise<void>(yes => { resolve = yes; }), resolve: () => resolve() };
  await open(); await selectAll(); await archive(); await act(async () => root.unmount()); mounted = false;
  await act(async () => hold!.resolve()); expect(calls).toHaveLength(1);
  root = createRoot(host); mounted = true; await open(); expect(host.textContent).not.toContain('成功 1'); expect(button('归档选中')?.disabled).toBe(true);
});
it('同名分享按类型与令牌区分，仅归档选中分享', async () => {
  data['/api/tokens'] = [{ name: 'same', type: 'sub', token: 't/1' }, { name: 'same', type: 'col', token: 't/2' }];
  await open('share'); await click(host.querySelectorAll<HTMLInputElement>('.ss-list-row input[type="checkbox"]')[1]); await archive();
  expect(calls).toEqual(['DELETE /api/token/t%2F2?type=col&name=same&mode=archive']); expect(data['/api/tokens']).toHaveLength(1);
});
it('归档恢复使用id区分同名条目，恢复冲突保留失败项', async () => {
  data['/api/archives'] = [{ name: 'same', id: 'a/1', itemType: 'sub' }, { name: 'same', id: 'a/2', itemType: 'sub' }];
  failures.add('/api/archives/a%2F2/restore'); await open('archive'); await selectAll(); await click(button('恢复选中'));
  expect(calls).toEqual(['POST /api/archives/a%2F1/restore', 'POST /api/archives/a%2F2/restore']); expect(host.textContent).toContain('失败 1');
  expect(host.querySelector<HTMLInputElement>('.ss-list-row input[type="checkbox"]')?.checked).toBe(true);
});
it('选中同步只逐项执行选中任务，失败不重跑成功项', async () => {
  data['/api/artifacts'] = [{ name: 'one' }, { name: 'two' }, { name: 'three' }]; failures.add('/api/sync/artifact/two');
  await open('artifact'); await click(check('one')); await click(check('two')); await click(button('同步选中'));
  expect(calls).toEqual(['GET /api/sync/artifact/one', 'GET /api/sync/artifact/two']); expect(check('one')?.checked).toBe(false); expect(check('two')?.checked).toBe(true); expect(check('three')?.checked).toBe(false);
});
it('同步归档保留本地成功并明确远端清理失败，已归档项不能误重试', async () => {
  data['/api/artifacts'] = [{ name: 'uploaded', updated: 1, upload: true }];
  responseData = { artifact: data['/api/artifacts'][0], remote: { attempted: true, status: 'failed', message: '未设置 GitHub Token！' } };
  await open('artifact'); await selectAll(); await click(button('归档选中'));
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('远端'); await click(button('确认归档'));
  expect(host.textContent).toContain('成功 1'); expect(host.textContent).toContain('远端清理失败'); expect(host.textContent).toContain('未设置 GitHub Token！');
  expect(button('归档选中')).toBeUndefined(); expect(calls).toEqual(['DELETE /api/artifact/uploaded?mode=archive']);
});
it('执行后列表刷新失败仍保留逐项结果，不能把成功项重新当待执行', async () => {
  await open(); await click(check('A')); await click(button('归档选中')); failures.add('/api/subs'); await click(button('确认归档'));
  expect(host.textContent).toContain('成功 1'); expect(host.textContent).toContain('引用读取失败'); expect(check('A')?.checked).toBe(false); expect(button('归档选中')?.disabled).toBe(true);
});

it('真实引擎批量归档与恢复保留完整来源，选中同步只更新目标任务', async () => {
  const engine = await startTestSubStore('.cache/batch-operations-20261123');
  const pending = new Set<Promise<unknown>>();
  const settle = async () => { do { await act(async () => { await Promise.allSettled([...pending]); }); } while (pending.size); };
  try {
    const content = JSON.stringify({ proxies: [{ name: 'QA', type: 'ss', server: '192.0.2.1', port: 443, cipher: 'aes-128-gcm', password: 'synthetic' }] });
    for (const name of ['engine-A', 'engine-B']) await engine.call('/api/subs', { name, source: 'local', content, process: [], advanced: { preserve: true } }, 'POST', 201);
    await engine.call('/api/files', { name: '真实处理器引用文件', type: 'mihomoConfig', sourceType: 'none', process: [{ type: 'Add Proxies From Subscription Operator', args: { sourceName: 'engine-A' } }] }, 'POST', 201);
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'sub_store_status') return { phase: 'running', version: '2.44.16' };
      const { request: r } = args as { request: { path: string; method: string; body?: unknown } };
      const request = engine.http(r.path, r.body, r.method); pending.add(request);
      try { return (await request).text; } finally { pending.delete(request); }
    });
    await open(); await settle(); await selectAll(); await click(button('归档选中')); await settle();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('真实处理器引用文件');
    await click(button('确认归档')); await settle(); expect(await engine.call('/api/subs')).toEqual([]);
    await click(button('归档')); await settle(); await selectAll(); await click(button('恢复选中')); await settle(); expect(await engine.call('/api/archives')).toEqual([]);
    for (const name of ['engine-A', 'engine-B']) expect(await engine.call(`/api/sub/${name}`)).toMatchObject({ name, content, advanced: { preserve: true } });
    for (const name of ['sync-A', 'sync-B']) await engine.call('/api/artifacts', { name, type: 'subscription', source: 'engine-A', platform: 'ClashMeta', sync: false, upload: false }, 'POST', 201);
    await click(button('同步')); await settle(); await click(check('sync-A')); await click(button('同步选中')); await settle();
    expect(await engine.call('/api/artifact/sync-A')).toHaveProperty('updated'); expect(await engine.call('/api/artifact/sync-B')).not.toHaveProperty('updated');
    // 空设置在本地拒绝远端清理，不向任何供应商发送请求。
    await engine.call('/api/artifacts', { name: 'uploaded-no-token', type: 'subscription', source: 'engine-A', platform: 'ClashMeta', upload: true, updated: 1 }, 'POST', 201);
    await click(host.querySelector('[aria-label="刷新 Sub-Store 列表"]')); await settle(); await click(check('uploaded-no-token'));
    await click(button('归档选中')); await settle(); await click(button('确认归档')); await settle();
    expect(host.textContent).toContain('成功 1'); expect(host.textContent).toContain('远端清理失败'); expect(host.textContent).toContain('未设置 GitHub Token');
    expect((await engine.call('/api/artifacts') as Entry[]).map(entry => entry.name)).not.toContain('uploaded-no-token');
  } finally { await engine.close(); }
}, 20000);
