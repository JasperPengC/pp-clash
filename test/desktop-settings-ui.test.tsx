// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RulesPage } from '../src/pages/Rules';
import { SettingsPage } from '../src/pages/Settings';
import { DEFAULT_SETTINGS, useApp } from '../src/store/app';
import { useViewPreferences } from '../src/store/view-preferences';
import { api } from '../src/core/api';

vi.mock('../src/core/api', async (original) => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, isTauri: true, api: {
    ...actual.api, mihomo: vi.fn(), listBackups: vi.fn(), backupAppState: vi.fn(), restoreBackup: vi.fn(),
    getWebDavSettings: vi.fn().mockResolvedValue({ settings: { endpoint: '', directory: 'backups', username: '', deviceName: 'Mac', schedule: 'off', retention: 7 }, configured: false, hasPassword: false, hasBackupPassphrase: false, credentialStore: { status: 'available', backend: 'macosKeychain' } }),
  } };
});
vi.mock('../src/core/webdav-service', () => ({ webdavService: { status: vi.fn().mockResolvedValue({ phase: 'disabled', lastSuccessAt: null, nextDueAt: null, error: null }) } }));

let root: Root; let host: HTMLDivElement;
const notify = vi.fn(); const applyConfig = vi.fn(); const restartKernel = vi.fn();
const backup = { name: 'backup.json', size: 2048, mtimeMs: 1_700_000_000_000 };
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')]
  .find((item) => item.textContent?.trim() === name)!;
const click = async (element: HTMLElement) => act(async () => element.click());
async function enter(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  useViewPreferences.setState(useViewPreferences.getInitialState(), true);
  vi.useFakeTimers(); vi.clearAllMocks();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  applyConfig.mockResolvedValue(true); restartKernel.mockResolvedValue(true);
  vi.mocked(api.mihomo).mockResolvedValue({ rules: [] });
  vi.mocked(api.listBackups).mockResolvedValue([]);
  vi.mocked(api.backupAppState).mockResolvedValue('backups/backup.json');
  vi.mocked(api.restoreBackup).mockResolvedValue(undefined);
  useApp.setState({ ...useApp.getInitialState(), settings: { ...DEFAULT_SETTINGS, customRules: [] },
    profiles: [{ id: 'active', name: '测试订阅', url: 'https://example.test', raw: 'proxies: []\nproxy-groups: []\nrules: []', updatedAt: 1, userinfo: null, updateIntervalHours: null }],
    groups: [], activeId: 'active',
    kernelPhase: 'running', connectedAt: null, checkingUpdate: false, updateInfo: null,
    notify, applyConfig, restartKernel,
    updateSettings: (patch) => useApp.setState((state) => ({ settings: { ...state.settings, ...patch } })),
  });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

it.each(['添加', '导入'])('没有活动订阅时仍可%s规则，提示连接后生效', async (action) => {
  useApp.setState({ profiles: [], activeId: action === '添加' ? null : 'missing', kernelPhase: 'stopped' });
  applyConfig.mockResolvedValue(false);
  await act(async () => root.render(createElement(RulesPage)));
  if (action === '添加') {
    await enter(host.querySelector<HTMLInputElement>('[aria-label="规则内容"]')!, 'example.com');
    await click(button('添加'));
    expect(host.querySelector<HTMLInputElement>('[aria-label="规则内容"]')!.value).toBe('');
  } else {
    await click(button('导入'));
    await enter(host.querySelector<HTMLTextAreaElement>('textarea')!, '[{"type":"DOMAIN","payload":"example.com","target":"DIRECT"}]');
    await click(button('从文本导入'));
    expect(host.querySelector('textarea')).toBeNull();
  }
  expect(useApp.getState().settings.customRules).toEqual([
    expect.objectContaining({ payload: 'example.com', target: action === '添加' ? '__CURRENT__' : 'DIRECT', enabled: true }),
  ]);
  expect(notify).toHaveBeenCalledWith('info', expect.stringContaining('导入订阅并连接后生效'));
  expect(notify.mock.calls.some(([kind]) => kind === 'error')).toBe(false);
  expect(applyConfig).not.toHaveBeenCalled();
  expect(restartKernel).not.toHaveBeenCalled();
});

it.each(['apply', 'restart'])('规则%s失败保留编辑内容，重试只添加一条规则', async (failure) => {
  useApp.setState({ configPath: '/mock/attempted-config.yaml' });
  (failure === 'apply' ? applyConfig : restartKernel).mockResolvedValueOnce(false);
  await act(async () => root.render(createElement(RulesPage)));
  const input = host.querySelector<HTMLInputElement>('[aria-label="规则内容"]')!;
  await enter(input, 'example.com'); await click(button('添加'));
  expect(input.value).toBe('example.com');
  expect(useApp.getState().configPath).toBe('');
  expect(notify.mock.calls.some(([kind]) => kind === 'success')).toBe(false);
  if (failure === 'apply') expect(restartKernel).not.toHaveBeenCalled();
  await click(button('添加'));
  expect(input.value).toBe('');
  expect(useApp.getState().settings.customRules).toHaveLength(1);
});

it('规则导入失败保留文本，应用中阻止重复导入及其他规则操作', async () => {
  const pending = deferred<boolean>(); applyConfig.mockReturnValueOnce(pending.promise);
  await act(async () => root.render(createElement(RulesPage)));
  await click(button('导入'));
  const input = host.querySelector<HTMLTextAreaElement>('textarea')!;
  const text = '[{"type":"DOMAIN","payload":"example.com","target":"DIRECT"}]';
  await enter(input, text); await click(button('从文本导入'));
  expect(button('从文本导入').disabled).toBe(true);
  expect(button('添加').disabled).toBe(true);
  await click(button('从文本导入')); expect(applyConfig).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(false));
  expect(host.querySelector('textarea')?.value).toBe(text);
  expect(button('从文本导入').disabled).toBe(false);
});

it.each(['[]', '[{"type":"DOMAIN","payload":"new.test","target":"DIRECT"},{"type":"DOMAIN","payload":"old.test","target":"DIRECT"}]'])('规则导入保留原规则并合并去重：%s', async (text) => {
  const original = { id: 'old', type: 'DOMAIN', payload: 'old.test', target: 'DIRECT', enabled: false };
  useApp.setState({ settings: { ...DEFAULT_SETTINGS, customRules: [original] }, profiles: [], activeId: null, kernelPhase: 'stopped' });
  await act(async () => root.render(createElement(RulesPage)));
  await click(button('导入'));
  await enter(host.querySelector<HTMLTextAreaElement>('textarea')!, text);
  await click(button('从文本导入'));
  const result = useApp.getState().settings.customRules;
  expect(result[0]).toEqual(original);
  expect(result.filter(rule => rule.payload === 'old.test')).toHaveLength(1);
  expect(result).toHaveLength(text === '[]' ? 1 : 2);
});

it('生效规则区分加载、读取失败与空结果，并允许重试', async () => {
  const pending = deferred<unknown>(); vi.mocked(api.mihomo).mockReturnValueOnce(pending.promise);
  await act(async () => root.render(createElement(RulesPage)));
  expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(host.textContent).not.toContain('暂无规则');
  await act(async () => pending.reject(new Error('controller unavailable')));
  expect(host.textContent).toContain('controller unavailable'); expect(host.textContent).not.toContain('暂无规则');
  await click(button('重试')); expect(host.textContent).toContain('暂无规则');
});

it('重新连接读取新规则，过期请求不能恢复断开前的数据', async () => {
  const old = deferred<unknown>(); vi.mocked(api.mihomo).mockReturnValueOnce(old.promise);
  await act(async () => root.render(createElement(RulesPage)));
  await act(async () => useApp.setState({ kernelPhase: 'stopped' }));
  await act(async () => useApp.setState({ kernelPhase: 'running', connectedAt: 123 }));
  await act(async () => old.resolve({ rules: [{ type: 'DOMAIN', payload: 'stale.example', proxy: 'DIRECT' }] }));
  expect(api.mihomo).toHaveBeenCalledTimes(2);
  expect(host.textContent).not.toContain('stale.example');
});

it.each(['mtime_ms', 'mtimeMs'])('备份列表读取%s字段显示真实本地时间', async (timeField) => {
  const nativeBackup = [{ name: 'state-before-Mwb8Yk.json', size: 2048,
    [timeField]: new Date(2026, 10, 23, 0, 42).getTime() }];
  vi.mocked(api.listBackups).mockResolvedValue(nativeBackup as unknown as Awaited<ReturnType<typeof api.listBackups>>);
  await act(async () => root.render(createElement(SettingsPage)));
  await click(button('备份与恢复'));
  expect(host.textContent).toContain('恢复前 · 11-23 00:42');
  expect(host.textContent).not.toContain('NaN');
});

it.each([undefined, NaN, Infinity, 8_640_000_000_000_001])('备份时间无效（%s）时显示时间未知', async (mtime_ms) => {
  const nativeBackup = [{ name: 'state-before-Mwb8Yk.json', size: 2048, mtime_ms }];
  vi.mocked(api.listBackups).mockResolvedValue(nativeBackup as unknown as Awaited<ReturnType<typeof api.listBackups>>);
  await act(async () => root.render(createElement(SettingsPage)));
  await click(button('备份与恢复'));
  expect(host.textContent).toContain('恢复前 · 时间未知');
  expect(host.textContent).not.toContain('NaN');
});

it('备份列表读取失败可重试，加载期间不显示暂无备份', async () => {
  const pending = deferred<typeof backup[]>(); vi.mocked(api.listBackups).mockReturnValueOnce(pending.promise);
  await act(async () => root.render(createElement(SettingsPage)));
  await click(button('备份与恢复'));
  expect(host.textContent).not.toContain('暂无备份');
  await act(async () => pending.reject(new Error('permission denied')));
  expect(host.textContent).toContain('permission denied'); expect(host.textContent).not.toContain('暂无备份');
  await click(button('重试')); expect(host.textContent).toContain('暂无备份');
});

it('备份期间禁止并行恢复，失败后两种操作都可重试', async () => {
  vi.mocked(api.listBackups).mockResolvedValue([backup]);
  const pending = deferred<string>(); vi.mocked(api.backupAppState).mockReturnValueOnce(pending.promise);
  await act(async () => root.render(createElement(SettingsPage)));
  await click(button('备份与恢复'));
  await click(button('备份'));
  expect(button('恢复').disabled).toBe(true);
  await click(button('恢复')); expect(api.restoreBackup).not.toHaveBeenCalled();
  await act(async () => pending.reject(new Error('disk full')));
  expect(button('备份').disabled).toBe(false); expect(button('恢复').disabled).toBe(false);
  expect(notify).toHaveBeenCalledWith('error', expect.stringContaining('disk full'));
});

it('移除出口策略后设置页不再为其保留配置应用锁', async () => {
  vi.mocked(api.listBackups).mockResolvedValue([backup]);
  await act(async () => root.render(createElement(SettingsPage)));
  await click(button('备份与恢复'));
  expect(host.querySelector('[aria-label="GitHub 固定出口"]')).toBeNull();
  await click(button('备份'));
  expect(api.backupAppState).toHaveBeenCalledTimes(1);
});

it('恢复完成到重新加载前仍锁住备份和恢复操作', async () => {
  vi.mocked(api.listBackups).mockResolvedValue([backup]);
  const pending = deferred<void>(); vi.mocked(api.restoreBackup).mockReturnValueOnce(pending.promise);
  await act(async () => root.render(createElement(SettingsPage)));
  await click(button('备份与恢复'));
  await click(button('恢复')); await click(button('确认恢复'));
  expect(button('备份').disabled).toBe(true);
  await act(async () => pending.resolve());
  expect(button('备份').disabled).toBe(true);
  expect(button('恢复').disabled).toBe(true);
  expect(api.restoreBackup).toHaveBeenCalledTimes(1);
});

it.each([null, 'missing'])('没有活动订阅（%s）时也不显示应用自带的 GitHub 固定出口', async (activeId) => {
  useApp.setState({ profiles: [], activeId, kernelPhase: 'stopped' });
  await act(async () => root.render(createElement(SettingsPage)));
  await click(button('备份与恢复'));
  expect(host.querySelector('[aria-label="GitHub 固定出口"]')).toBeNull();
  expect(applyConfig).not.toHaveBeenCalled();
  expect(restartKernel).not.toHaveBeenCalled();
});

it('设置页不再触发 GitHub 固定出口配置生成', async () => {
  await act(async () => root.render(createElement(SettingsPage)));
  await click(button('备份与恢复'));
  expect(host.querySelector('[aria-label="GitHub 固定出口"]')).toBeNull();
  expect(applyConfig).not.toHaveBeenCalled();
  expect(restartKernel).not.toHaveBeenCalled();
});

it('规则刷新失败保留旧数据且注明，筛选无结果可恢复', async () => {
  vi.mocked(api.mihomo).mockResolvedValueOnce({ rules: [{ type: 'DOMAIN', payload: 'example.com', proxy: 'DIRECT' }] });
  await act(async () => root.render(createElement(RulesPage)));
  await enter(host.querySelector<HTMLInputElement>('[aria-label="搜索生效规则"]')!, 'absent');
  expect(host.textContent).toContain('没有匹配的规则');
  await click(button('清空筛选')); expect(host.textContent).toContain('example.com');
  vi.mocked(api.mihomo).mockRejectedValueOnce(new Error('read failed'));
  await click(host.querySelector<HTMLElement>('[aria-label="刷新生效规则"]')!);
  expect(host.textContent).toContain('上次读取'); expect(host.textContent).toContain('example.com');
  expect(host.textContent).not.toContain('暂无规则');
});

it('规则保存抛异常仍保留编辑内容并解锁', async () => {
  applyConfig.mockRejectedValueOnce(new Error('write failed'));
  await act(async () => root.render(createElement(RulesPage)));
  const input = host.querySelector<HTMLInputElement>('[aria-label="规则内容"]')!;
  await enter(input, 'example.com'); await click(button('添加'));
  expect(input.value).toBe('example.com'); expect(button('添加').disabled).toBe(false);
  expect(useApp.getState().settings.customRules).toHaveLength(0);
  expect(notify).toHaveBeenCalledWith('error', expect.stringContaining('write failed'));
});

it('恢复失败重新开放确认与备份，允许重试原备份', async () => {
  vi.mocked(api.listBackups).mockResolvedValue([backup]);
  vi.mocked(api.restoreBackup).mockRejectedValueOnce(new Error('invalid backup'));
  await act(async () => root.render(createElement(SettingsPage)));
  await click(button('备份与恢复'));
  await click(button('恢复')); await click(button('确认恢复'));
  expect(button('备份').disabled).toBe(false); expect(button('恢复').disabled).toBe(false);
  expect(notify).toHaveBeenCalledWith('error', expect.stringContaining('invalid backup'));
  await click(button('恢复')); await click(button('确认恢复'));
  expect(api.restoreBackup).toHaveBeenCalledTimes(2);
  expect(button('备份').disabled).toBe(true);
});

it('设置页不再为 GitHub 固定出口提供重启切换', async () => {
  await act(async () => root.render(createElement(SettingsPage)));
  await click(button('备份与恢复'));
  expect(host.querySelector('[aria-label="GitHub 固定出口"]')).toBeNull();
  expect(applyConfig).not.toHaveBeenCalled();
  expect(restartKernel).not.toHaveBeenCalled();
});
