// @vitest-environment happy-dom
import { act, createElement, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsPage } from '../src/pages/Settings';
import { ResourcesPage } from '../src/pages/Resources';
import { RulesPage } from '../src/pages/Rules';
import { ConnectionsPage } from '../src/pages/Connections';
import { LogsPage } from '../src/pages/Logs';
import { OverridePage } from '../src/pages/Override';
import { api } from '../src/core/api';
import { useApp } from '../src/store/app';
import { useViewPreferences } from '../src/store/view-preferences';

vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, isTauri: false, api: { ...actual.api,
    mihomo: vi.fn(), listResourceFiles: vi.fn(), readKernelLog: vi.fn(),
  } };
});
let root: Root; let host: HTMLDivElement;
const render = (Page: ComponentType<any>) => act(async () => root.render(createElement(Page)));
const revisit = async (Page: ComponentType<any>) => { await act(async () => root.render(null)); await render(Page); };
async function choose(group: string, text: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>(`[aria-label="${group}"] button`)]
    .find(button => button.textContent?.startsWith(text));
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
const selected = (group: string) => host.querySelector(`[aria-label="${group}"] [aria-pressed="true"], [aria-label="${group}"] [aria-selected="true"]`)?.textContent;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); vi.clearAllMocks();
  useViewPreferences.setState(useViewPreferences.getInitialState(), true);
  const initial = useApp.getInitialState();
  useApp.setState({ ...initial, kernelPhase: 'running', settings: { ...initial.settings, overrides: [
    { id: 'one', name: '第一份', mode: 'yaml', enabled: true, text: '' },
    { id: 'two', name: '工作配置', mode: 'yaml', enabled: true, text: '' },
  ] } });
  vi.mocked(api.listResourceFiles).mockResolvedValue([]);
  vi.mocked(api.readKernelLog).mockResolvedValue('2026-11-21 INFO connected');
  vi.mocked(api.mihomo).mockImplementation(async (_method, path) => path === '/connections'
    ? { connections: [{ id: 'one', start: '2026-11-21T10:00:00Z', upload: 10, download: 20,
      metadata: { host: 'example.test', process: 'Browser', type: 'HTTP', network: 'tcp' }, chains: ['DIRECT'], rule: 'Match' }], uploadTotal: 10, downloadTotal: 20 }
    : path === '/rules' ? { rules: [] } : { providers: {} });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('设置离页后返回原分类', async () => {
  await render(SettingsPage); await choose('设置分类', '下载');
  await revisit(SettingsPage);
  expect(selected('设置分类')).toBe('下载');
  expect(host.querySelector('.settings-section')?.getAttribute('aria-label')).toBe('下载');
});

it.each([
  ['资源', ResourcesPage, '资源类型', '节点来源'],
  ['规则', RulesPage, '规则视图', '订阅'],
] as const)('%s 离页后返回原标签', async (_name, Page, group, label) => {
  await render(Page); await choose(group, label); await revisit(Page);
  expect(selected(group)).toContain(label);
});

it('连接视图和排序分别恢复', async () => {
  await render(ConnectionsPage);
  await choose('连接视图', '按进程'); await choose('连接排序', '上传');
  await revisit(ConnectionsPage);
  expect(selected('连接视图')).toBe('按进程');
  expect(selected('连接排序')).toBe('上传');
});

it('日志返回时保留级别和原始视图', async () => {
  await render(LogsPage); await choose('日志级别', '警告');
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="原始日志"]')!.click());
  await revisit(LogsPage);
  expect(selected('日志级别')).toBe('警告');
  expect(host.querySelector('[aria-label="原始日志"]')?.getAttribute('aria-pressed')).toBe('true');
});

it('覆写返回时保留选择的文件，文件被移除后回退有效文件', async () => {
  await render(OverridePage);
  const file = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('工作配置'))!;
  await act(async () => file.click());
  await revisit(OverridePage);
  expect(host.querySelector<HTMLInputElement>('[aria-label="覆写名称"]')?.value).toBe('工作配置');
  await act(async () => useApp.setState(state => ({ settings: { ...state.settings, overrides: state.settings.overrides.slice(0, 1) } })));
  expect(host.querySelector<HTMLInputElement>('[aria-label="覆写名称"]')?.value).toBe('第一份');
});
