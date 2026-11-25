// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Sidebar, type PageKey } from '../src/components/Sidebar';
import App from '../src/App';
import { DEFAULT_SETTINGS, useApp } from '../src/store/app';

vi.mock('../src/components/VersionBadge', () => ({ VersionBadge: () => createElement('button', { type: 'button', 'aria-label': '检查更新' }, '版本') }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  useApp.setState({ ...useApp.getInitialState(), settings: { ...DEFAULT_SETTINGS, advancedMode: true } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it('侧栏保留十三个功能页，设置由主区工具栏承接', async () => {
  const change = vi.fn();
  await act(async () => root.render(createElement(Sidebar, { current: 'overview', onChange: change })));
  const pages: PageKey[] = ['overview', 'proxies', 'profiles', 'substore', 'connections', 'traffic', 'logs', 'rules', 'dns', 'security', 'override', 'resources', 'kernel'];
  const buttons = [...host.querySelectorAll<HTMLButtonElement>('nav button')];
  expect(buttons).toHaveLength(pages.length);
  for (const button of buttons) await act(async () => button.click());
  expect(change.mock.calls.map(([page]) => page)).toEqual(pages);
  expect(host.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  expect(host.querySelector('[aria-current="page"]')?.textContent).toBe('概览');
  await act(async () => root.render(createElement(Sidebar, { current: 'settings', onChange: change })));
  expect(host.querySelector('[aria-current="page"]')).toBeNull();
  expect(host.querySelector('nav[aria-label="设置"]')).toBeNull();
});

it('普通模式保留基本功能，侧栏不重复设置入口', async () => {
  useApp.setState({ settings: { ...DEFAULT_SETTINGS, advancedMode: false } });
  const change = vi.fn();
  await act(async () => root.render(createElement(Sidebar, { current: 'profiles', onChange: change })));
  expect(host.querySelectorAll('nav button')).toHaveLength(6);
  expect(host.querySelector('nav[aria-label="配置与诊断"]')).toBeNull();
  expect(host.querySelector('nav[aria-label="工具"]')).toBeNull();
  expect(host.querySelector('nav[aria-label="设置"]')).toBeNull();
});

it('高级模式在原侧栏内响应更新，入口不丢失且不会重复跳转', async () => {
  const change = vi.fn();
  useApp.setState({ settings: { ...DEFAULT_SETTINGS, advancedMode: false } });
  await act(async () => root.render(createElement(Sidebar, { current: 'overview', onChange: change })));
  await act(async () => useApp.setState({ settings: { ...DEFAULT_SETTINGS, advancedMode: true } }));
  expect(host.querySelectorAll('nav button')).toHaveLength(13);
  const dns = [...host.querySelectorAll<HTMLButtonElement>('nav button')].find(button => button.textContent === 'DNS 配置')!;
  await act(async () => dns.click());
  expect(change).toHaveBeenCalledExactlyOnceWith('dns');
});

it('页面头直接占据主区首行，窗口拖拽占位仍留在侧栏而非重复标题栏', async () => {
  await act(async () => root.render(createElement(App)));
  await act(async () => { await vi.dynamicImportSettled(); });
  const main = host.querySelector('main.desktop-main');
  expect(main).not.toBeNull();
  const frame = main?.parentElement;
  expect(frame?.classList.contains('workspace-frame')).toBe(true);
  expect(frame?.firstElementChild?.getAttribute('aria-label')).toBe('窗口工具栏');
  expect(main?.querySelector('.workspace-toolbar')).toBeNull();
  expect(main?.querySelector(':scope > .titlebar')).toBeNull();
  expect(main?.querySelector('.page-anim > :first-child')?.classList.contains('page-head')).toBe(true);
  const chrome = host.querySelector('.sidebar > [data-tauri-drag-region]');
  expect(chrome).not.toBeNull();
  expect(chrome?.textContent).toBe('');
  expect(host.querySelector('[aria-current="page"]')?.textContent).toBe('概览');
});

it('桌面窗口拦截浏览器原生右键菜单', async () => {
  await act(async () => root.render(createElement(App)));
  const shell = host.querySelector<HTMLElement>('.window-shell')!;
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  shell.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
});

it('主区左上设置图标与右侧模式切换共用工具栏，运行状态集中在侧栏底部', async () => {
  await act(async () => root.render(createElement(App)));
  const toolbar = host.querySelector<HTMLElement>('.workspace-toolbar');
  expect(toolbar?.querySelector('[aria-label="窗口运行状态"]')).toBeNull();
  expect(toolbar?.querySelector('[aria-label="出站模式"]')).not.toBeNull();
  expect(host.querySelector('.page-head [aria-label="出站模式"]')).toBeNull();
  expect(toolbar?.querySelector('[aria-label="切换外观"]')).toBeNull();
  expect(toolbar?.querySelector('[aria-label="文字大小"]')).toBeNull();
  expect(toolbar?.querySelector('[aria-label="打开设置"]')).not.toBeNull();
  expect(toolbar?.querySelector('.toolbar-divider')).toBeNull();
});

it('主区更新提示的图标操作带名称，切页仍沿原有回调更新当前页', async () => {
  useApp.setState({ updateInfo: { version: '9.0.0', url: 'https://example.com/update', notes: '' } });
  await act(async () => root.render(createElement(App)));
  const close = host.querySelector<HTMLButtonElement>('.update-banner .icon-btn')!;
  expect(close.getAttribute('aria-label')).toBe('关闭更新提示');
  await act(async () => close.click());
  expect(host.querySelector('.update-banner')).toBeNull();
  const settings = host.querySelector<HTMLButtonElement>('.workspace-toolbar [aria-label="打开设置"]')!;
  await act(async () => settings.click());
  await act(async () => { await vi.dynamicImportSettled(); });
  expect(settings.getAttribute('aria-current')).toBe('page');
  expect(host.querySelector('main .page-anim:not([style*="display: none"]) .page-title')?.textContent).toBe('设置');
});

it.each([
  ['running', true, false, '运行中', '系统代理已开启', 'PROXY'],
  ['running', false, true, '运行中', 'TUN 模式已开启', 'TUN'],
  ['running', true, true, '运行中', '系统代理与 TUN 已开启', 'TUN'],
  ['running', false, false, '运行中', '未接管系统流量', '未接管'],
  ['stopped', true, true, '未运行', '接管未开启', '未运行'],
  ['failed', false, false, '异常', '查看错误详情', '异常'],
] as const)('侧栏运行卡片展示 %s 的真实接管状态', async (kernelPhase, sysProxyEnabled, tunEnabled, status, detail, label) => {
  const change = vi.fn();
  useApp.setState({ kernelPhase, sysProxyEnabled, tunEnabled });
  await act(async () => root.render(createElement(Sidebar, { current: 'overview', onChange: change })));
  const card = host.querySelector<HTMLButtonElement>('.sidebar-runtime-main')!;
  expect(card.textContent).toContain('mihomo');
  expect(card.getAttribute('aria-label')).toContain(status);
  expect(card.getAttribute('aria-label')).toContain(detail);
  expect(card.querySelector('.sidebar-runtime-mode')?.textContent).toBe(label);
  expect(card.querySelector('.sidebar-runtime-mode')?.nextElementSibling?.textContent).toContain('mihomo');
  expect(card.querySelector('svg')).toBeNull();
  expect(card.textContent).not.toContain('应用版本');
  await act(async () => card.click());
  expect(change).toHaveBeenCalledWith('kernel');
});
