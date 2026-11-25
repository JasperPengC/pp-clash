// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../src/core/api';
import { requestSubStore } from '../src/core/sub-store/service';
import { SubStorePreview } from '../src/core/sub-store/preview';
import { webdavService } from '../src/core/webdav-service';
import { useApp } from '../src/store/app';
import { useViewPreferences } from '../src/store/view-preferences';
import { SubStorePage } from '../src/pages/SubStore';
import { WebDavBackup } from '../src/components/WebDavBackup';

vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, isTauri: true, api: { ...actual.api, getWebDavSettings: vi.fn(), saveWebDavSettings: vi.fn(), testWebDavConnection: vi.fn() } };
});
vi.mock('../src/core/sub-store/service', () => ({ getSubStoreStatus: vi.fn().mockResolvedValue({ phase: 'running', version: '2.44.16' }), startSubStore: vi.fn(), stopSubStore: vi.fn(), requestSubStore: vi.fn() }));
vi.mock('../src/core/webdav-service', () => ({ webdavService: { status: vi.fn(), backupNow: vi.fn(), history: vi.fn(), delete: vi.fn(), preview: vi.fn(), restore: vi.fn() } }));
vi.mock('../src/components/CodeEditor', () => ({ default: ({ value, onChange, disabled, placeholder }: { value: string; onChange: (value: string) => void; disabled: boolean; placeholder: string }) => createElement('textarea', { 'aria-label': placeholder, value, disabled, onChange: (event: { target: { value: string } }) => onChange(event.target.value) }) }));
let root: Root; let host: HTMLDivElement;
const initial = useApp.getInitialState();
const renameReferences = vi.fn();
let counter = 0; let sourceName: string;
const source = () => ({ name: sourceName, source: 'remote', url: 'https://source.test/sub', process: [], customAdvanced: { keep: true } });
const snapshot = { settings: { endpoint: 'https://dav.test/', directory: 'backups', username: 'user', deviceName: 'Mac', schedule: 'daily' as const, retention: 7 }, deviceId: 'local', configured: true, hasPassword: null, hasBackupPassphrase: true, credentialStore: { backend: 'macosKeychain' as const, status: 'available' as const } };
const byText = (text: string) => [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === text)!;
const click = async (element: Element) => act(async () => (element as HTMLElement).click());
const input = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
});
const render = async (page: () => React.JSX.Element) => act(async () => root.render(createElement(page)));

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); sourceName = `source-${++counter}`;
  useViewPreferences.getState().setPreference('subStoreTab', 'sub');
  renameReferences.mockResolvedValue(undefined);
  useApp.setState(Object.assign({ ...initial, profiles: [], addSubStoreProfile: vi.fn().mockResolvedValue(undefined), restoreBackup: vi.fn().mockResolvedValue(undefined) }, { renameSubStoreReferences: renameReferences }));
  vi.mocked(requestSubStore).mockImplementation(async path => path === '/api/subs' ? [source()] : path === `/api/sub/${sourceName}` ? source() : []);
  vi.mocked(api.getWebDavSettings).mockResolvedValue(snapshot);
  vi.mocked(webdavService.status).mockResolvedValue({ phase: 'idle', lastSuccessAt: null, nextDueAt: 1000, error: null });
  vi.mocked(webdavService.history).mockResolvedValue({ items: [{ name: 'ppclash-1-Mac.ppbackup', deviceName: 'Mac', createdAt: 1, size: 2048, isCurrentDevice: true }], total: 1, offset: 0, limit: 10 });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

it.each([
  { kind: 'sub', label: '来源', createPath: '/api/subs', listPath: '/api/subs', itemPrefix: '/api/sub' },
  { kind: 'collection', label: '组合', createPath: '/api/collections', listPath: '/api/collections', itemPrefix: '/api/collection' },
  { kind: 'file', label: '文件', createPath: '/api/files', listPath: '/api/wholeFiles', itemPrefix: '/api/wholeFile' },
  { kind: 'artifact', label: '同步', createPath: '/api/artifacts', listPath: '/api/artifacts', itemPrefix: '/api/artifact' },
] as const)('新增 $label 使用官方创建路由 $createPath 并读取完整保存对象', async ({ kind, label, createPath, listPath, itemPrefix }) => {
  useViewPreferences.getState().setPreference('subStoreTab', kind);
  const name = `created-${kind}-${sourceName}`;
  let saved: { name: string; [key: string]: unknown } | null = null;
  const request = vi.mocked(requestSubStore).mockImplementation(async (path, body, method) => {
    if (method === 'POST' && path === createPath) { saved = { ...body as Record<string, unknown>, name, serverNormalized: true }; return saved; }
    if (method && method !== 'GET') throw new Error(`HTTP 404: ${method} ${path}`);
    if (path === listPath) return saved ? [saved] : kind === 'sub' ? [source()] : [];
    if (path === `${itemPrefix}/${name}` && saved) return saved;
    if (path === '/api/subs') return [source()];
    if (path === '/api/collections') return [];
    throw new Error(`HTTP 404: GET ${path}`);
  });
  await render(SubStorePage); await click(host.querySelector(`[aria-label="新增${label}"]`)!);
  await input(host.querySelector('[aria-label="名称"]')!, name);
  if (kind === 'sub' || kind === 'file') await input(host.querySelector('[aria-label="远程链接"]')!, 'https://source.test/new');
  else if (kind === 'collection') await click(host.querySelector('.ss-source-choices input')!);
  else await input(host.querySelector('[aria-label="同步来源名称"]')!, sourceName);
  await click(byText('保存草稿'));
  expect(request.mock.calls.filter(call => call[2] === 'POST')).toEqual([[createPath, expect.objectContaining({ name }), 'POST']]);
  expect(request).toHaveBeenCalledWith(`${itemPrefix}/${name}`);
  expect(host.textContent).toContain('草稿已保存'); expect(host.textContent).not.toContain('HTTP 404');
  if (kind === 'file') expect(host.textContent).not.toContain('加入应用后才会成为应用订阅');
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="JSON 对象"]')?.value).toContain('"serverNormalized": true');
  await click(host.querySelector('[aria-label="返回列表"]')!);
  expect(byText(name)).toBeDefined();
});

it('直接进入文件页读取来源与组合，缺失引用阻止保存和预览请求', async () => {
  useViewPreferences.getState().setPreference('subStoreTab', 'file');
  const file = { name: `file-${sourceName}`, type: 'mihomoConfig', sourceType: 'subscription', sourceName: 'deleted-sub', process: [] };
  const request = vi.mocked(requestSubStore).mockImplementation(async path => {
    if (path === '/api/wholeFiles') return [file];
    if (path === `/api/wholeFile/${file.name}`) return file;
    if (path === '/api/subs') return [source()];
    if (path === '/api/collections') return [{ name: 'existing-col', displayName: '现有组合' }];
    throw new Error(`未预期请求 ${path}`);
  });
  await render(SubStorePage); await click(byText(file.name));
  expect(host.textContent).toContain('已不存在');
  await input(host.querySelector('[aria-label="显示名称"]')!, '修改');
  await click(byText('真实预览')); await click(byText('保存草稿'));
  expect(request.mock.calls.some(call => call[2] === 'POST' || call[2] === 'PATCH')).toBe(false);
  await click(host.querySelector('[aria-label="Mihomo 内容来源"]')!);
  await click([...document.querySelectorAll('[role="option"]')].find(element => element.textContent === '已有组合')!);
  await click(host.querySelector('[aria-label="选择组合"]')!);
  expect([...document.querySelectorAll('[role="option"]')].some(element => element.textContent === '现有组合')).toBe(true);
});
it.each([
  ['subscription', 'config', '来源 · referenced'], ['collection', 'config', '组合 · referenced'],
  ['local', 'config', '本地配置'], ['local', 'proxy', '本地节点'],
  ['remote', 'config', '远程配置'], ['remote', 'proxy', '远程节点'], ['none', 'config', '空配置'],
])('Mihomo文件列表按有效来源%s/%s显示，而不使用陈旧普通文件source', async (sourceType, mode, expected) => {
  useViewPreferences.getState().setPreference('subStoreTab', 'file');
  vi.mocked(requestSubStore).mockImplementation(async path => path === '/api/wholeFiles' ? [{ name: `summary-${sourceName}`, type: 'mihomoConfig', sourceType, sourceName: 'referenced', mode, source: 'remote', url: 'https://example.invalid/stale' }] : []);
  await render(SubStorePage);
  expect(host.querySelector('.ss-entry-copy p')?.textContent).toBe(expected);
});

it('Sub-Store 保存失败保留高级字段与可重试草稿，重复点击只提交一次', async () => {
  await render(SubStorePage); await click(byText(sourceName));
  await input(host.querySelector('[aria-label="显示名称"]')!, '修改后的名称');
  let reject!: (reason: Error) => void;
  const request = vi.mocked(requestSubStore);
  request.mockImplementation(async (path, _body, method) => method === 'PATCH' ? new Promise((_resolve, fail) => { reject = fail; }) : path === '/api/subs' ? [source()] : []);
  await act(async () => { byText('保存草稿').click(); byText('保存草稿').click(); });
  expect(request.mock.calls.filter(call => call[2] === 'PATCH')).toHaveLength(1);
  expect(request.mock.calls.find(call => call[2] === 'PATCH')?.[1]).toMatchObject({ displayName: '修改后的名称', customAdvanced: { keep: true } });
  await act(async () => reject(new Error('网络不可用')));
  expect(host.querySelector<HTMLInputElement>('[aria-label="显示名称"]')?.value).toBe('修改后的名称');
  expect(host.textContent).toContain('网络不可用');
  expect(byText('保存草稿').disabled).toBe(false);
});

it('私有后端的令牌管理明确说明其他客户端无法直接使用', async () => {
  useViewPreferences.getState().setPreference('subStoreTab', 'share');
  const share = { name: sourceName, type: 'sub', token: `private-${sourceName}`, mode: 'duration', expiresValue: '7', expiresUnit: 'day' };
  vi.mocked(requestSubStore).mockImplementation(async path => path === '/api/tokens' ? [share] : []);
  await render(SubStorePage);
  expect(host.textContent).toContain('暂不支持外部订阅链接');
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  await click(byText('复制令牌'));
  expect(writeText).toHaveBeenCalledWith(share.token);
  expect(host.textContent).toContain('令牌已复制');
  await click(byText(sourceName));
  expect(host.textContent).toContain('暂不支持外部订阅链接');
});

it('正则排序可逐行编辑多个表达式并保留顺序提交', async () => {
  let serviceEntry = { ...source(), process: [{ type: 'Regex Sort Operator', args: { expressions: ['HK', 'SG'], order: 'asc' } }] };
  const request = vi.mocked(requestSubStore).mockImplementation(async (path, body, method) => {
    if (method === 'PATCH' && path === `/api/sub/${sourceName}`) { serviceEntry = body as typeof serviceEntry; return serviceEntry; }
    if (path === '/api/subs') return [serviceEntry];
    if (path === `/api/sub/${sourceName}`) return serviceEntry;
    throw new Error(`HTTP 404: ${method ?? 'GET'} ${path}`);
  });
  await render(SubStorePage); await click(byText(sourceName)); await click(byText('处理器'));
  const expressions = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="排序表达式（每行一个）"]');
  expect(expressions).not.toBeNull(); expect(expressions?.value).toBe('HK\nSG');
  await input(expressions!, 'HK\nTW\nUS'); await click(byText('保存草稿'));
  expect(request.mock.calls.find(call => call[2] === 'PATCH')?.[1]).toMatchObject({ process: [{ type: 'Regex Sort Operator', args: { expressions: ['HK', 'TW', 'US'], order: 'asc' } }] });
});

it.each(['root', 'processor'] as const)('%s非法JSON草稿返回列表后原样恢复，修正前不能预览或保存', async target => {
  let serviceEntry = { ...source(), process: target === 'processor' ? [{ type: 'Regex Filter', args: { regex: ['HK'], keep: true } }] : [] };
  const request = vi.mocked(requestSubStore).mockImplementation(async (path, body, method) => {
    if (method === 'PATCH' && path === `/api/sub/${sourceName}`) { serviceEntry = body as typeof serviceEntry; return serviceEntry; }
    if (path === '/api/subs') return [serviceEntry];
    if (path === `/api/sub/${sourceName}`) return serviceEntry;
    throw new Error(`HTTP 404: ${method ?? 'GET'} ${path}`);
  });
  await render(SubStorePage); await click(byText(sourceName)); await click(byText(target === 'root' ? '完整参数' : '处理器'));
  const invalid = target === 'root' ? '{"name":' : '{"type":';
  const raw = () => target === 'root' ? host.querySelector<HTMLTextAreaElement>('.ss-form-panel:last-child [aria-label="JSON 对象"]')! : host.querySelector<HTMLTextAreaElement>('.ss-step [aria-label="JSON 对象"]')!;
  await input(raw(), invalid); expect(byText('保存草稿').disabled).toBe(true);
  await click(host.querySelector('[aria-label="返回列表"]')!);
  expect(byText(`恢复草稿 · ${sourceName}`)).toBeDefined();
  await click(byText(`恢复草稿 · ${sourceName}`));
  expect(raw().value).toBe(invalid);
  expect(byText('保存草稿').disabled).toBe(true); expect(byText('真实预览').disabled).toBe(true);
  expect(request.mock.calls.some(call => call[2] === 'PATCH' || call[2] === 'POST')).toBe(false);
  const fixed = target === 'root' ? { ...serviceEntry, remark: 'JSON修正' } : { type: 'Regex Filter', args: { regex: ['TW'], keep: true } };
  await input(raw(), JSON.stringify(fixed)); await click(byText('保存草稿'));
  expect(request.mock.calls.filter(call => call[2] === 'PATCH')).toHaveLength(1);
  expect(host.textContent).toContain('草稿已保存');
  await click(host.querySelector('[aria-label="返回列表"]')!);
  expect(host.textContent).not.toContain(`恢复草稿 · ${sourceName}`);
});

it('处理器移动时非法JSON跟随原处理器，明确移除后清除其阻塞状态', async () => {
  const entry = { ...source(), process: [{ type: 'Regex Filter', args: { regex: ['HK'], keep: true } }, { type: 'Sort Operator', args: 'asc' }] };
  vi.mocked(requestSubStore).mockImplementation(async path => path === '/api/subs' ? [entry] : entry);
  await render(SubStorePage); await click(byText(sourceName)); await click(byText('处理器'));
  const raw = (index: number) => host.querySelectorAll<HTMLTextAreaElement>('.ss-step [aria-label="JSON 对象"]')[index];
  await input(raw(0), '{"type":');
  await click(host.querySelector('[aria-label="下移处理器 1"]')!);
  expect(raw(1).value).toBe('{"type":'); expect(byText('保存草稿').disabled).toBe(true);
  await click(host.querySelector('[aria-label="移除处理器 2"]')!);
  expect(byText('保存草稿').disabled).toBe(false); expect(byText('真实预览').disabled).toBe(false);
});

it('相同处理器移动并移除非法JSON后，保留下来的处理器恢复有效文本', async () => {
  const processor = { type: 'Regex Filter', args: { regex: ['HK'], keep: true } };
  const entry = { ...source(), process: [structuredClone(processor), structuredClone(processor)] };
  vi.mocked(requestSubStore).mockImplementation(async path => path === '/api/subs' ? [entry] : entry);
  await render(SubStorePage); await click(byText(sourceName)); await click(byText('处理器'));
  const raw = (index: number) => host.querySelectorAll<HTMLTextAreaElement>('.ss-step [aria-label="JSON 对象"]')[index];
  await input(raw(0), '{"type":'); await click(host.querySelector('[aria-label="下移处理器 1"]')!);
  expect(raw(1).value).toBe('{"type":');
  expect(JSON.parse(raw(0).value)).toEqual(processor);
  await click(host.querySelector('[aria-label="移除处理器 2"]')!);
  expect(JSON.parse(raw(0).value)).toEqual(processor);
  expect(host.querySelector('.ss-step [role="alert"]')).toBeNull();
  expect(byText('保存草稿').disabled).toBe(false); expect(byText('真实预览').disabled).toBe(false);
});

it('完整参数明确替换process为空后清除旧处理器孤立JSON草稿', async () => {
  let entry = { ...source(), process: [{ type: 'Regex Filter', args: { regex: ['HK'], keep: true } }] };
  const request = vi.mocked(requestSubStore).mockImplementation(async (path, body, method) => {
    if (method === 'PATCH' && path === `/api/sub/${sourceName}`) { entry = body as typeof entry; return entry; }
    if (path === '/api/subs') return [entry];
    if (path === `/api/sub/${sourceName}`) return entry;
    throw new Error(`HTTP 404: ${method ?? 'GET'} ${path}`);
  });
  await render(SubStorePage); await click(byText(sourceName)); await click(byText('处理器'));
  await input(host.querySelector('.ss-step [aria-label="JSON 对象"]')!, '{"type":');
  await click(byText('完整参数'));
  await input(host.querySelector('.ss-form-panel:last-child [aria-label="JSON 对象"]')!, JSON.stringify({ ...entry, process: [] }));
  expect(host.querySelectorAll('.ss-step')).toHaveLength(0);
  expect(byText('保存草稿').disabled).toBe(false);
  await click(byText('保存草稿'));
  expect(request.mock.calls.find(call => call[2] === 'PATCH')?.[1]).toMatchObject({ process: [] });
  await click(host.querySelector('[aria-label="返回列表"]')!);
  expect(host.textContent).not.toContain(`恢复草稿 · ${sourceName}`);
});

it.each(['mihomoConfig', 'mihomoProfile'])('%s配置文件引用组合时可修改备注，保存不丢高级来源', async type => {
  useViewPreferences.getState().setPreference('subStoreTab', 'file');
  const name = `config-${sourceName}`;
  let entry = { name, type, source: 'local', sourceType: 'collection', sourceName: 'C', process: [], customAdvanced: { keep: true } };
  const request = vi.mocked(requestSubStore).mockImplementation(async (path, body, method) => {
    if (method === 'PATCH' && path === `/api/file/${name}`) { entry = body as typeof entry; return entry; }
    if (path === '/api/wholeFiles') return [entry];
    if (path === `/api/wholeFile/${name}`) return entry;
    if (path === '/api/subs') return [source()];
    if (path === '/api/collections') return [{ name: 'C', subscriptions: [sourceName] }];
    throw new Error(`HTTP 404: ${method ?? 'GET'} ${path}`);
  });
  await render(SubStorePage); await click(byText(name));
  await input(host.querySelector('[aria-label="备注"]')!, '配置备注'); await click(byText('保存草稿'));
  expect(request.mock.calls.find(call => call[2] === 'PATCH')?.[1]).toMatchObject({ type, sourceType: 'collection', sourceName: 'C', remark: '配置备注', customAdvanced: { keep: true } });
  expect(host.textContent).toContain('草稿已保存');
});

it('加入应用重新下载真实结果并调用store导入，失败不展示成功', async () => {
  await render(SubStorePage);
  vi.mocked(requestSubStore).mockResolvedValue('proxies:\n  - { name: one, type: ss }');
  vi.mocked(useApp.getState().addSubStoreProfile).mockRejectedValueOnce(new Error('候选配置校验失败'));
  await click(byText('加入应用'));
  expect(requestSubStore).toHaveBeenCalledWith(`/download/${sourceName}?target=ClashMeta`, undefined, 'GET', expect.any(SubStorePreview));
  expect(useApp.getState().addSubStoreProfile).toHaveBeenCalledWith(sourceName, { kind: 'sub', name: sourceName }, 'proxies:\n  - { name: one, type: ss }');
  expect(host.textContent).toContain('候选配置校验失败');
  expect(host.textContent).not.toContain('已加入应用订阅');
});

it('分享修改先创建新令牌，生成失败时旧分享保持有效且草稿保留', async () => {
  useViewPreferences.getState().setPreference('subStoreTab', 'share');
  const share = { name: sourceName, type: 'sub', token: 'old-token', mode: 'duration', expiresValue: '7', expiresUnit: 'day' };
  vi.mocked(requestSubStore).mockImplementation(async (path, _body, method) => {
    if (method === 'POST') throw new Error('创建失败');
    return path === '/api/tokens' ? [share] : [];
  });
  await render(SubStorePage); await click(byText(sourceName));
  await input(host.querySelector('[aria-label="显示名称"]')!, '分享改名');
  await click(byText('保存草稿'));
  const calls = vi.mocked(requestSubStore).mock.calls;
  expect(calls.find(call => call[0] === '/api/token')?.[1]).toMatchObject({ payload: { name: sourceName, displayName: '分享改名' } });
  expect(calls.some(call => call[2] === 'DELETE')).toBe(false);
  expect(host.textContent).toContain('创建失败');
  expect(host.querySelector<HTMLInputElement>('[aria-label="显示名称"]')?.value).toBe('分享改名');
});

it.each([
  { error: '请先保存 WebDAV 设置', visible: false },
  { error: '备份记录损坏，请检查本地文件', visible: true },
])('未配置备份仅隐藏默认提醒，真实错误仍显示：$error', async ({ error, visible }) => {
  vi.mocked(api.getWebDavSettings).mockResolvedValue({ ...snapshot, configured: false });
  vi.mocked(webdavService.status).mockResolvedValue({ phase: 'error', lastSuccessAt: null, nextDueAt: null, error });
  await render(WebDavBackup);
  expect(host.textContent?.includes(error)).toBe(visible);
});

it('未保存的密码与口令可直接输入，保存时明确替换而不是切换下拉状态', async () => {
  vi.mocked(api.getWebDavSettings).mockResolvedValue({ ...snapshot, hasPassword: false, hasBackupPassphrase: false });
  vi.mocked(api.saveWebDavSettings).mockResolvedValue(snapshot);
  await render(WebDavBackup);
  expect(host.querySelector('[aria-label="服务器密码处理方式"]')).toBeNull();
  expect(host.querySelector('[aria-label="备份口令处理方式"]')).toBeNull();
  await input(host.querySelector('[aria-label="服务器密码"]')!, 'server-secret');
  await input(host.querySelector('[aria-label="备份口令"]')!, 'backup-secret');
  await click(byText('保存设置'));
  expect(api.saveWebDavSettings).toHaveBeenCalledWith(expect.objectContaining({ password: { intent: 'replace', value: 'server-secret' }, backupPassphrase: { intent: 'replace', value: 'backup-secret' } }));
});
it('已保存凭据不回显，留空保留；清除与撤销只影响明确操作的字段', async () => {
  vi.mocked(api.getWebDavSettings).mockResolvedValue({ ...snapshot, hasPassword: true });
  vi.mocked(api.saveWebDavSettings).mockResolvedValue({ ...snapshot, hasPassword: true });
  await render(WebDavBackup);
  const password = host.querySelector<HTMLInputElement>('[aria-label="服务器密码"]')!;
  expect(password?.value).toBe('');
  await input(host.querySelector('[aria-label="云备份本机名称"]')!, '新设备名');
  await click(byText('保存设置'));
  expect(api.saveWebDavSettings).toHaveBeenLastCalledWith(expect.objectContaining({ password: { intent: 'keep' }, backupPassphrase: { intent: 'keep' } }));
  await input(password, 'replacement'); await input(password, '');
  expect(byText('保存设置').disabled).toBe(true);
  await click(host.querySelector('[aria-label="清除服务器密码"]')!);
  await click(host.querySelector('[aria-label="撤销服务器密码修改"]')!);
  expect(byText('保存设置').disabled).toBe(true);
  await click(host.querySelector('[aria-label="清除服务器密码"]')!);
  await click(byText('保存设置'));
  expect(api.saveWebDavSettings).toHaveBeenLastCalledWith(expect.objectContaining({ password: { intent: 'clear' }, backupPassphrase: { intent: 'keep' } }));
});
it('WebDAV 凭据不可读取保留未知状态，保存失败保留设置草稿', async () => {
  await render(WebDavBackup);
  expect(host.textContent).toContain('无法读取保存状态');
  await input(host.querySelector('[aria-label="云备份本机名称"]')!, '工作电脑');
  vi.mocked(api.saveWebDavSettings).mockRejectedValueOnce(new Error('凭据服务不可用'));
  await click(byText('保存设置'));
  expect(api.saveWebDavSettings).toHaveBeenCalledWith(expect.objectContaining({ password: { intent: 'keep' }, backupPassphrase: { intent: 'keep' } }));
  expect(host.querySelector<HTMLInputElement>('[aria-label="云备份本机名称"]')?.value).toBe('工作电脑');
  expect(host.textContent).toContain('未保存'); expect(host.textContent).toContain('凭据服务不可用');
});

it('WebDAV 身份变更不能keep旧密码；测试连接不隐式保存', async () => {
  await render(WebDavBackup);
  await input(host.querySelector('[aria-label="WebDAV 账号"]')!, 'another-user');
  expect(host.textContent).toContain('请重新输入服务器密码或明确清除');
  expect(byText('保存设置').disabled).toBe(true);
  expect(byText('测试连接').disabled).toBe(true);
  await input(host.querySelector('[aria-label="WebDAV 账号"]')!, 'user');
  vi.mocked(api.testWebDavConnection).mockResolvedValueOnce({ directoryExists: true, willCreateOnBackup: false });
  await click(byText('测试连接'));
  expect(api.testWebDavConnection).toHaveBeenCalledTimes(1); expect(api.saveWebDavSettings).not.toHaveBeenCalled();
});

it('云备份解密预览后必须明确确认才进入store恢复事务', async () => {
  await render(WebDavBackup); await click(byText('备份历史')); await click(byText('恢复'));
  await input(document.querySelector('[aria-label="恢复云备份口令"]')!, 'backup-passphrase');
  vi.mocked(webdavService.preview).mockResolvedValueOnce({ device: 'Mac', profiles: 2, collections: 1, digest: 'verified-digest' });
  await act(async () => { const form = document.querySelector('[aria-label="恢复云备份口令"]')!.closest('form')!; form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(useApp.getState().restoreBackup).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('恢复前会停止内核');
  vi.useFakeTimers(); await click(byText('确认恢复'));
  expect(useApp.getState().restoreBackup).toHaveBeenCalledWith({ savedWebDav: true, name: 'ppclash-1-Mac.ppbackup', passphrase: 'backup-passphrase', digest: 'verified-digest' });
});

it('分享固定时间用本地日期控件，提交官方毫秒并保留高级字段', async () => {
  useViewPreferences.getState().setPreference('subStoreTab', 'share');
  const share = { name: sourceName, type: 'sub', token: `datetime-${sourceName}`, mode: 'datetime', exp: 1925028000000, advanced: { preserve: true } };
  let savedShare = share;
  vi.mocked(requestSubStore).mockImplementation(async (path, body, method) => {
    if (method === 'POST') { if (path !== '/api/token') throw new Error(`HTTP 404: POST ${path}`); const { payload, options } = body as { payload: Record<string, unknown>; options: Record<string, unknown> }; savedShare = { ...payload, ...options, token: 'new-datetime-token' } as typeof share; return savedShare; }
    return path === '/api/tokens' ? [savedShare] : [];
  });
  await render(SubStorePage); await click(byText(sourceName));
  const dateInput = host.querySelector<HTMLInputElement>('input[type="datetime-local"]');
  expect(dateInput).not.toBeNull();
  await input(dateInput!, '2031-03-22T09:30'); await click(byText('保存草稿'));
  expect(vi.mocked(requestSubStore).mock.calls.find(call => call[0] === '/api/token')?.[1]).toMatchObject({ payload: { advanced: { preserve: true } }, options: { mode: 'datetime', exp: new Date('2031-03-22T09:30').getTime() } });
});

it.each(['default-collection', 'processor-subscription', 'disabled-processor-collection'])('%s引用改名使未保存文件草稿失效，保留草稿供核对', async shape => {
  const kind = shape === 'processor-subscription' ? 'sub' : 'collection';
  const entry = kind === 'sub' ? source() : { name: sourceName, subscriptions: ['synthetic'], process: [] };
  const file = shape === 'default-collection'
    ? { name: `file-${sourceName}`, type: 'mihomoConfig', sourceName, process: [] }
    : { name: `file-${sourceName}`, type: 'mihomoConfig', sourceType: 'none', process: [{ type: 'Add Proxies From Subscription Operator', disabled: shape.startsWith('disabled'), args: { sourceName, ...(kind === 'collection' ? { sourceType: 'collection' } : {}) } }] };
  useViewPreferences.getState().setPreference('subStoreTab', 'file');
  vi.mocked(requestSubStore).mockImplementation(async (path, body, method) => {
    if (method === 'PATCH') return body;
    if (path === '/api/wholeFiles') return [file];
    if (path.startsWith('/api/wholeFile/')) return file;
    if (path === '/api/subs') return kind === 'sub' ? [entry] : [{ name: 'synthetic' }];
    if (path === '/api/collections') return kind === 'collection' ? [entry] : [];
    if (path.startsWith(`/api/${kind}/`)) return entry;
    return [];
  });
  await render(SubStorePage); await click(byText(file.name));
  await input(host.querySelector('[aria-label="备注"]')!, '未保存的内容');
  await click(host.querySelector('[aria-label="返回列表"]')!);
  await click(byText(kind === 'sub' ? '来源' : '组合')); await click(byText(sourceName));
  await input(host.querySelector('[aria-label="名称"]')!, `${sourceName}-new`); await click(byText('保存草稿'));
  await click(host.querySelector('[aria-label="返回列表"]')!); await click(byText('文件')); await click(byText(file.name));
  expect(host.textContent).toContain('关联来源已变更');
  expect(byText('保存草稿').disabled).toBe(true);
  expect(host.querySelector<HTMLInputElement>('[aria-label="备注"]')?.value).toBe('未保存的内容');
});

it('来源他处重命名后，已保存组合重新读取服务中的subscriptions', async () => {
  useViewPreferences.getState().setPreference('subStoreTab', 'collection');
  let collection = { name: `collection-${sourceName}`, subscriptions: ['before'], process: [], normalized: 'server' };
  const request = vi.mocked(requestSubStore).mockImplementation(async (path, body, method) => {
    if (method === 'PATCH') { collection = { ...collection, ...body as typeof collection }; return collection; }
    if (path === '/api/collections') return [collection];
    if (path.startsWith('/api/collection/')) return collection;
    if (path === '/api/subs') return [{ ...source(), name: 'before' }, { ...source(), name: 'after' }];
    return [];
  });
  await render(SubStorePage); await click(byText(collection.name));
  await input(host.querySelector('[aria-label="显示名称"]')!, '组合显示名'); await click(byText('保存草稿'));
  await click(host.querySelector('[aria-label="返回列表"]')!);
  collection = { ...collection, subscriptions: ['after'] };
  request.mockClear(); await click(byText('组合显示名'));
  expect(request).toHaveBeenCalledWith(`/api/collection/${collection.name}`);
  const choices = [...host.querySelectorAll<HTMLInputElement>('.ss-source-choices input')];
  expect(choices.find(choice => choice.parentElement?.textContent === 'after')?.checked).toBe(true);
  expect(choices.find(choice => choice.parentElement?.textContent === 'before')?.checked).toBe(false);
});

it('不同分享对象复用token时草稿与React条目身份互不串线', async () => {
  useViewPreferences.getState().setPreference('subStoreTab', 'share');
  const shares = [{ name: `${sourceName}-A`, type: 'sub', token: 'same-token', mode: 'duration', expiresValue: '7', expiresUnit: 'day' }, { name: `${sourceName}-B`, type: 'sub', token: 'same-token', mode: 'duration', expiresValue: '7', expiresUnit: 'day' }];
  vi.mocked(requestSubStore).mockResolvedValue(shares);
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  await render(SubStorePage); await click(byText(shares[0].name));
  await input(host.querySelector('[aria-label="显示名称"]')!, 'A的草稿'); await click(host.querySelector('[aria-label="返回列表"]')!);
  await click(byText(shares[1].name));
  expect(host.querySelector<HTMLInputElement>('[aria-label="分享对象名称"]')?.value).toBe(shares[1].name);
  expect(host.querySelector<HTMLInputElement>('[aria-label="显示名称"]')?.value).toBe('');
  await click(host.querySelector('[aria-label="返回列表"]')!); await click(byText(shares[0].name));
  expect(host.querySelector<HTMLInputElement>('[aria-label="显示名称"]')?.value).toBe('A的草稿');
  expect(errors.mock.calls.some(call => String(call[0]).includes('same key'))).toBe(false); errors.mockRestore();
});

it('来源重命名迁移应用引用，持久化失败回滚服务并保留草稿', async () => {
  let serviceEntry = source();
  const request = vi.mocked(requestSubStore).mockImplementation(async (path, body, method) => {
    if (method === 'PATCH') { serviceEntry = body as typeof serviceEntry; return serviceEntry; }
    return path === '/api/subs' ? [serviceEntry] : serviceEntry;
  });
  renameReferences.mockRejectedValueOnce(new Error('应用磁盘不可写'));
  await render(SubStorePage); await click(byText(sourceName));
  await input(host.querySelector('[aria-label="名称"]')!, `${sourceName}-new`); await click(byText('保存草稿'));
  expect(renameReferences).toHaveBeenCalledWith({ kind: 'sub', oldName: sourceName, newName: `${sourceName}-new` });
  expect(request.mock.calls.filter(call => call[2] === 'PATCH')).toHaveLength(2);
  expect(request.mock.calls.filter(call => call[2] === 'PATCH')[1]).toEqual([`/api/sub/${sourceName}-new`, expect.objectContaining({ name: sourceName }), 'PATCH']);
  expect(serviceEntry.name).toBe(sourceName); expect(host.textContent).toContain('应用磁盘不可写');
  expect(host.querySelector<HTMLInputElement>('[aria-label="名称"]')?.value).toBe(`${sourceName}-new`);
  expect(byText('保存草稿').disabled).toBe(false);
});

it('应用引用更新与服务名称回滚都失败时保留草稿并明确双错误', async () => {
  let serviceEntry = source(); let patches = 0;
  vi.mocked(requestSubStore).mockImplementation(async (path, body, method) => {
    if (method === 'PATCH') { if (++patches === 2) throw new Error('服务回滚失败'); serviceEntry = body as typeof serviceEntry; return serviceEntry; }
    return path === '/api/subs' ? [serviceEntry] : serviceEntry;
  });
  renameReferences.mockRejectedValueOnce(new Error('应用磁盘不可写'));
  await render(SubStorePage); await click(byText(sourceName));
  await input(host.querySelector('[aria-label="名称"]')!, `${sourceName}-new`); await click(byText('保存草稿'));
  expect(host.textContent).toContain('应用磁盘不可写'); expect(host.textContent).toContain('服务回滚失败');
  expect(serviceEntry.name).toBe(`${sourceName}-new`); expect(host.querySelector<HTMLInputElement>('[aria-label="名称"]')?.value).toBe(`${sourceName}-new`);
  expect(host.textContent).not.toContain('草稿已保存');
});

it.each(['sub', 'collection'] as const)('%s改名双失败后刷新列表并恢复草稿，可以按实际服务身份完成重试', async kind => {
  useViewPreferences.getState().setPreference('subStoreTab', kind);
  const originalName = kind === 'sub' ? sourceName : `retry-collection-${sourceName}`;
  const newName = `${originalName}-new`;
  let serviceEntry: { name: string; [key: string]: unknown } = kind === 'sub' ? source() : { name: originalName, subscriptions: [sourceName], process: [] };
  const otherEntry = { ...serviceEntry, name: `${originalName}-taken` };
  let patches = 0;
  const request = vi.mocked(requestSubStore).mockImplementation(async (path, body, method) => {
    if (method === 'PATCH') {
      if (path !== `/api/${kind}/${serviceEntry.name}`) throw new Error('服务条目不存在');
      if (++patches === 2) throw new Error('服务回滚失败');
      serviceEntry = body as typeof serviceEntry; return serviceEntry;
    }
    if (path === '/api/subs') return kind === 'sub' ? [serviceEntry, otherEntry] : [source()];
    if (path === '/api/collections') return kind === 'collection' ? [serviceEntry, otherEntry] : [];
    return path === `/api/${kind}/${serviceEntry.name}` ? serviceEntry : [];
  });
  renameReferences.mockRejectedValueOnce(new Error('应用磁盘不可写'));
  await render(SubStorePage); await click(byText(originalName));
  await input(host.querySelector('[aria-label="名称"]')!, newName); await click(byText('保存草稿'));
  expect(host.textContent).toContain('服务回滚失败');
  await click(host.querySelector('[aria-label="返回列表"]')!);
  await click(host.querySelector('[aria-label="刷新 Sub-Store 列表"]')!);
  expect(byText(newName)).toBeDefined();
  await click(byText(`恢复草稿 · ${newName}`));
  await input(host.querySelector('[aria-label="名称"]')!, otherEntry.name); await click(byText('保存草稿'));
  expect(host.textContent).toContain('已有同名条目'); expect(patches).toBe(2);
  await input(host.querySelector('[aria-label="名称"]')!, newName); await click(byText('保存草稿'));
  expect(request.mock.calls.filter(call => call[2] === 'PATCH').at(-1)).toEqual([`/api/${kind}/${newName}`, expect.objectContaining({ name: newName }), 'PATCH']);
  expect(patches).toBe(3); expect(renameReferences).toHaveBeenCalledTimes(2);
  expect(renameReferences).toHaveBeenLastCalledWith({ kind, oldName: originalName, newName });
  expect(host.textContent).toContain('草稿已保存'); expect(host.textContent).not.toContain('应用引用迁移尚未完成');
  await click(host.querySelector('[aria-label="返回列表"]')!);
  expect(host.textContent).not.toContain(`恢复草稿 · ${newName}`);
});

it('分享普通时长在失焦及提交时统一官方两位小数精度', async () => {
  useViewPreferences.getState().setPreference('subStoreTab', 'share');
  let share = { name: sourceName, type: 'sub', token: `duration-${sourceName}`, mode: 'duration', expiresValue: '7', expiresUnit: 'day', expiresIn: '604800s' };
  vi.mocked(requestSubStore).mockImplementation(async (path, body, method) => {
    if (method === 'POST') { if (path !== '/api/token') throw new Error(`HTTP 404: POST ${path}`); const { payload, options } = body as { payload: Record<string, unknown>; options: Record<string, unknown> }; share = { ...payload, ...options, token: `new-duration-${sourceName}` } as typeof share; return share; }
    return path === '/api/tokens' ? [share] : [];
  });
  await render(SubStorePage); await click(byText(sourceName));
  const durationInput = host.querySelector<HTMLInputElement>('[aria-label="有效时长"]')!;
  await act(async () => durationInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
  expect(byText('保存草稿').disabled).toBe(true);
  await input(durationInput, '1.111');
  await act(async () => durationInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
  expect(durationInput.value).toBe('1.11');
  await click(byText('保存草稿'));
  expect(vi.mocked(requestSubStore).mock.calls.find(call => call[0] === '/api/token')?.[1]).toMatchObject({ options: { expiresValue: '1.11', expiresIn: '95904s' } });
  expect(host.textContent).toContain('分享令牌已保存');
});

it('来源改名使关联dirty组合草稿待核对，用户明确重载前不丢修改', async () => {
  useViewPreferences.getState().setPreference('subStoreTab', 'collection');
  let serviceEntry = source();
  let collection = { name: `dirty-collection-${sourceName}`, subscriptions: [sourceName], process: [] };
  vi.mocked(requestSubStore).mockImplementation(async (path, body, method) => {
    if (method === 'PATCH') { const value = body as typeof serviceEntry; serviceEntry = value; collection = { ...collection, subscriptions: [value.name] }; return { ...value, serverNormalized: true }; }
    if (path === '/api/subs') return [serviceEntry];
    if (path.startsWith('/api/sub/')) return { ...serviceEntry, serverNormalized: true };
    if (path === '/api/collections') return [collection];
    if (path.startsWith('/api/collection/')) return collection;
    return [];
  });
  await render(SubStorePage); await click(byText(collection.name));
  await input(host.querySelector('[aria-label="显示名称"]')!, '尚未保存的组合修改');
  await click(host.querySelector('[aria-label="返回列表"]')!); await click(byText('来源')); await click(byText(sourceName));
  await input(host.querySelector('[aria-label="名称"]')!, `${sourceName}-new`); await click(byText('保存草稿'));
  expect(renameReferences).toHaveBeenCalledWith({ kind: 'sub', oldName: sourceName, newName: `${sourceName}-new` });
  await click(host.querySelector('[aria-label="返回列表"]')!); await click(byText('组合')); await click(byText(collection.name));
  expect(host.querySelector<HTMLInputElement>('[aria-label="显示名称"]')?.value).toBe('尚未保存的组合修改');
  expect(host.textContent).toContain('关联来源已变更'); expect(byText('保存草稿').disabled).toBe(true);
  await click(byText('读取最新内容并放弃此草稿'));
  expect(host.querySelector<HTMLInputElement>('[aria-label="显示名称"]')?.value).toBe('');
  expect(host.querySelector<HTMLInputElement>('.ss-source-choices input')?.checked).toBe(true);
});

it('关联分享草稿重载使用原对象三元身份并明确放弃修改', async () => {
  useViewPreferences.getState().setPreference('subStoreTab', 'share');
  const share = { name: sourceName, type: 'sub', token: `reload-${sourceName}`, mode: 'duration', expiresValue: '7', expiresUnit: 'day' };
  let serviceEntry = source();
  vi.mocked(requestSubStore).mockImplementation(async (path, body, method) => {
    if (method === 'PATCH') { serviceEntry = body as typeof serviceEntry; return serviceEntry; }
    if (path === '/api/tokens') return [share];
    return path === '/api/subs' ? [serviceEntry] : serviceEntry;
  });
  await render(SubStorePage); await click(byText(sourceName));
  await input(host.querySelector('[aria-label="显示名称"]')!, '分享未保存修改');
  await click(host.querySelector('[aria-label="返回列表"]')!); await click(byText('来源')); await click(byText(sourceName));
  await input(host.querySelector('[aria-label="名称"]')!, `${sourceName}-new`); await click(byText('保存草稿'));
  await click(host.querySelector('[aria-label="返回列表"]')!); await click(byText('分享')); await click(byText(sourceName));
  expect(byText('保存草稿').disabled).toBe(true);
  await click(byText('读取最新内容并放弃此草稿'));
  expect(host.querySelector<HTMLInputElement>('[aria-label="分享对象名称"]')?.value).toBe(sourceName);
  expect(host.querySelector<HTMLInputElement>('[aria-label="显示名称"]')?.value).toBe('');
  expect(host.textContent).not.toContain('关联来源已变更');
});

it('分享已从服务删除时不会用陈旧列表对象冒充成功读取', async () => {
  useViewPreferences.getState().setPreference('subStoreTab', 'share');
  const share = { name: sourceName, type: 'sub', token: `gone-${sourceName}`, mode: 'duration', expiresValue: '7', expiresUnit: 'day' };
  vi.mocked(requestSubStore).mockResolvedValueOnce([share]).mockResolvedValue([]);
  await render(SubStorePage); await click(byText(sourceName));
  expect(host.querySelector('[aria-label="分享对象名称"]')).toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('分享已不存在');
});

it('来源改名后关联高级文件草稿须重载再保存，保留服务器的新引用', async () => {
  useViewPreferences.getState().setPreference('subStoreTab', 'file');
  let serviceEntry = source();
  let file = { name: `linked-file-${sourceName}`, source: 'local', content: 'proxies: []', sourceType: 'subscription', sourceName, process: [] };
  vi.mocked(requestSubStore).mockImplementation(async (path, body, method) => {
    if (method === 'PATCH' && path.startsWith('/api/sub/')) { serviceEntry = body as typeof serviceEntry; file = { ...file, sourceName: serviceEntry.name }; return serviceEntry; }
    if (method === 'PATCH' && path.startsWith('/api/file/')) { file = body as typeof file; return file; }
    if (path === '/api/wholeFiles') return [file];
    if (path.startsWith('/api/wholeFile/')) return file;
    return path === '/api/subs' ? [serviceEntry] : serviceEntry;
  });
  await render(SubStorePage); await click(byText(file.name));
  await input(host.querySelector('[aria-label="显示名称"]')!, '文件未保存修改');
  await click(host.querySelector('[aria-label="返回列表"]')!); await click(byText('来源')); await click(byText(sourceName));
  await input(host.querySelector('[aria-label="名称"]')!, `${sourceName}-new`); await click(byText('保存草稿'));
  await click(host.querySelector('[aria-label="返回列表"]')!); await click(byText('文件')); await click(byText(file.name));
  expect(host.querySelector<HTMLInputElement>('[aria-label="显示名称"]')?.value).toBe('文件未保存修改');
  expect(byText('保存草稿').disabled).toBe(true);
  await click(byText('读取最新内容并放弃此草稿'));
  expect(host.querySelector<HTMLInputElement>('[aria-label="显示名称"]')?.value).toBe('');
  await input(host.querySelector('[aria-label="显示名称"]')!, '文件新修改'); await click(byText('保存草稿'));
  expect(vi.mocked(requestSubStore).mock.calls.filter(call => call[2] === 'PATCH').at(-1)?.[1]).toMatchObject({ sourceType: 'subscription', sourceName: `${sourceName}-new`, displayName: '文件新修改' });
});
