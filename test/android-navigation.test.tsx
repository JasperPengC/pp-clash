// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useApp } from '../src/store/app';
import { useViewPreferences } from '../src/store/view-preferences';
import { latencyTone } from '../src/core/latency';
import AndroidWindow from '../src/bootstrap/android-window';
import { APP_VERSION } from '../src/core/update';
import { PageHeader } from '../src/components/PageHeader';

vi.mock('../src/core/platform', () => ({ isAndroid: true, isWindows: false, isLinux: false }));
vi.mock('../src/core/api', async original => ({ ...await original<typeof import('../src/core/api')>(), isTauri: false }));
vi.mock('../src/dev/preview', () => ({ applyPreviewIfRequested: () => {} }));
vi.mock('../src/store/app', async original => {
  const actual = await original<typeof import('../src/store/app')>();
  actual.useApp.setState({ hydrate: vi.fn().mockResolvedValue(undefined) });
  return actual;
});
// 页面模块是路由的边界；实际导航、历史记录、返回桥接和弹层都由真实组件处理。
vi.mock('../src/pages/Traffic', () => ({ TrafficPage: () => createElement(PageHeader, { title: '流量统计' }) }));

let host: HTMLDivElement;
let root: Root;
const initial = useApp.getInitialState();
beforeEach(() => {
  useViewPreferences.setState(useViewPreferences.getInitialState(), true);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.documentElement.classList.add('android-window');
  window.history.replaceState({}, '');
  useApp.setState({ ...initial, kernelPhase: 'stopped', toast: null });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.documentElement.classList.remove('android-window');
  useApp.setState(initial);
});
const render = () => act(async () => root.render(createElement(AndroidWindow)));
const currentPage = () => host.querySelector('main')?.dataset.page;
const back = () => act(async () => { expect(window.ppclashAndroidBack?.()).toBe(true); });
const click = (text: string) => act(async () => {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text);
  expect(button).toBeTruthy();
  button!.click();
});

it('从恢复的主导航页面返回概览，不吞掉返回键', async () => {
  window.history.replaceState({ ppclashPage: 'more' }, '');
  await render();
  expect(currentPage()).toBe('more');
  await back();
  expect(currentPage()).toBe('overview');
  expect(window.ppclashAndroidBack?.()).toBe(false);
});

it('从恢复的工具页先回更多，再回概览', async () => {
  window.history.replaceState({ ppclashPage: 'traffic' }, '');
  await render();
  await back();
  expect(currentPage()).toBe('more');
  await back();
  expect(currentPage()).toBe('overview');
});

it('连接空状态的概览入口接通移动导航', async () => {
  await render();
  await click('连接');
  await act(async () => { await vi.dynamicImportSettled(); });
  const entry = host.querySelector<HTMLButtonElement>('[aria-label="去概览"]');
  expect(entry).not.toBeNull();
  await act(async () => entry!.click());
  expect(currentPage()).toBe('overview');
  expect(host.querySelector('.android-nav [aria-current="page"]')?.textContent).toBe('概览');
});

it('切换多个主导航后返回直接回概览，不逐个回放访问过的标签', async () => {
  await render();
  await click('订阅');
  await click('更多');
  await back();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(currentPage()).toBe('overview');
});

it('工具页提供可触摸的返回按钮', async () => {
  await render();
  await click('更多');
  await click('流量统计');
  const button = host.querySelector<HTMLButtonElement>('[aria-label="返回更多"]');
  expect(button).not.toBeNull();
  await act(async () => { button!.click(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(currentPage()).toBe('more');
});

it('Android更多入口提供Sub-Store并支持恢复工具页返回', async () => {
  window.history.replaceState({ ppclashPage: 'sub-store' }, '');
  await render();
  expect(currentPage()).toBe('sub-store');
  await back();
  expect(currentPage()).toBe('more');
  expect([...host.querySelectorAll('button')].some(button => button.textContent === 'Sub-Store')).toBe(true);
  expect([...host.querySelectorAll('button')].some(button => button.textContent === '覆写配置')).toBe(true);
  expect([...host.querySelectorAll('button')].some(button => button.textContent === '资源管理')).toBe(true);
});

it('主导航把当前页直接标记为选中，并响应 Android IME 高度', async () => {
  await render();
  const nav = host.querySelector<HTMLElement>('.android-nav');
  expect(nav?.querySelector('[aria-current="page"]')?.textContent).toContain('概览');
  await click('订阅');
  expect(host.querySelector('.android-nav [aria-current="page"]')?.textContent).toContain('订阅');
  await act(async () => window.dispatchEvent(new CustomEvent('ppclash-ime', { detail: { bottom: 296 } })));
  expect(host.querySelector('.android-shell')?.getAttribute('data-ime-open')).toBe('true');
  expect(document.documentElement.style.getPropertyValue('--android-ime-height')).toBe('296px');
  await act(async () => window.dispatchEvent(new CustomEvent('ppclash-ime', { detail: { bottom: 0 } })));
  expect(host.querySelector('.android-shell')?.getAttribute('data-ime-open')).toBeNull();
  expect(document.documentElement.style.getPropertyValue('--android-ime-height')).toBe('0px');
});

it('概览页把节点操作放在连接卡内，主开关独立于卡片', async () => {
  useApp.setState({
    activeId: 'one',
    kernelPhase: 'running',
    profiles: [{ id: 'one', name: '家庭订阅', source: 'https://example.com/sub', sourceType: 'url', updatedAt: Date.now() } as any],
    groups: [{ name: '自动选择', type: 'Selector', now: '东京-01', nodes: [{ name: '东京-01', type: 'Trojan', delay: 42 }] }],
  });
  await render();
  const connection = host.querySelector('[aria-label="当前连接"]');
  expect(connection).not.toBeNull();
  expect(host.querySelector('[aria-label="实时流量"]')).not.toBeNull();
  expect(connection?.querySelector('[aria-label="测速当前节点"]')).not.toBeNull();
  expect(connection?.querySelector('[aria-label="更新当前订阅"]')).not.toBeNull();
  expect(connection?.querySelector('.android-power')).toBeNull();
  expect(host.querySelector('[aria-label="VPN 连接开关"] .android-power')).not.toBeNull();
});

it.each([
  [1, 'good'], [119, 'good'], [120, 'warn'], [259, 'warn'], [260, 'bad'], [1000, 'bad'],
  [null, 'idle'], [undefined, 'idle'], [0, 'idle'], [-1, 'idle'], [NaN, 'idle'], [Infinity, 'idle'],
] as const)('桌面与移动端共享延迟边界 %s → %s', (delay, tone) => {
  expect(latencyTone(delay)).toBe(tone);
});

it('点击延迟环测速，期间阻止重复请求，完成后按新结果更新颜色', async () => {
  let finish!: (value: number | null) => void;
  const testDelay = vi.fn(() => new Promise<number | null>(resolve => { finish = resolve; }));
  useApp.setState({
    activeId: 'one', kernelPhase: 'running', testDelay,
    groups: [{ name: '常规', type: 'Selector', now: '东京-01', nodes: [{ name: '东京-01', type: 'Trojan', delay: 42 }] }],
  });
  await render();
  const ring = host.querySelector<HTMLButtonElement>('.android-latency-button')!;
  expect(ring.dataset.tone).toBe('good');
  await act(async () => { ring.click(); ring.click(); });
  expect(testDelay).toHaveBeenCalledTimes(1);
  expect(ring.disabled).toBe(true);
  expect(ring.getAttribute('aria-busy')).toBe('true');
  await act(async () => finish(260));
  expect(ring.disabled).toBe(false);
  expect(ring.dataset.tone).toBe('bad');
  expect(ring.textContent).toBe('260 ms');
  expect(useApp.getState().toast?.text).toContain('260 ms');
});

it('失败测速不保留成功圆弧，切换节点后的过期结果也不弹提示', async () => {
  let finish!: (value: number | null) => void;
  const testDelay = vi.fn(() => new Promise<number | null>(resolve => { finish = resolve; }));
  useApp.setState({
    activeId: 'one', kernelPhase: 'running', testDelay,
    groups: [{ name: '常规', type: 'Selector', now: '东京-01', nodes: [{ name: '东京-01', type: 'Trojan', delay: 42 }] }],
  });
  await render();
  const ring = host.querySelector<HTMLButtonElement>('.android-latency-button')!;
  await act(async () => ring.click());
  await act(async () => finish(null));
  expect(ring.dataset.tone).toBe('idle');
  expect(ring.textContent).toBe('失败');
  expect(ring.querySelector('.latency-ring-value')).toBeNull();
  await act(async () => { useApp.getState().clearToast(); ring.click(); });
  await act(async () => useApp.setState({ groups: [{ name: '常规', type: 'Selector', now: '新节点', nodes: [{ name: '新节点', type: 'Trojan', delay: 150 }] }] }));
  await act(async () => finish(20));
  expect(ring.dataset.tone).toBe('warn');
  expect(ring.textContent).toBe('150 ms');
  expect(useApp.getState().toast).toBeNull();
});

it('概览页直接显示当前节点，不重复放节点和订阅导航入口', async () => {
  useApp.setState({
    activeId: 'one',
    kernelPhase: 'running',
    profiles: [{ id: 'one', name: '家庭订阅', source: 'https://example.com/sub', sourceType: 'url', updatedAt: Date.now() } as any],
    groups: [{ name: '自动选择', type: 'Selector', now: '东京-01', nodes: [{ name: '东京-01', type: 'Trojan', delay: 42 }] }],
  });
  await render();
  expect(host.textContent).toContain('东京-01');
  expect(host.textContent).toContain('自动选择');
  expect(host.textContent).not.toContain('选择节点');
  expect(host.textContent).not.toContain('管理订阅');
});

it('返回优先关闭弹层，输入框聚焦时也不离开当前页', async () => {
  window.history.replaceState({ ppclashPage: 'more' }, '');
  await render();
  const dialog = document.createElement('div');
  dialog.setAttribute('aria-modal', 'true');
  const input = document.createElement('input');
  dialog.append(input);
  document.body.append(dialog);
  const dismiss = vi.fn((event: KeyboardEvent) => { if (event.key === 'Escape') dialog.remove(); });
  document.addEventListener('keydown', dismiss);
  try {
    input.focus();
    await back();
    expect(dialog.isConnected).toBe(false);
    expect(currentPage()).toBe('more');
  } finally {
    document.removeEventListener('keydown', dismiss);
    dialog.remove();
  }
});

it('设置显示版本并提供更新入口，下载中阻止重复安装', async () => {
  window.history.replaceState({ ppclashPage: 'more' }, '');
  const checkUpdate = vi.fn().mockResolvedValue(undefined);
  const downloadUpdate = vi.fn().mockResolvedValue(undefined);
  useApp.setState({ checkUpdate, downloadUpdate });
  await render();
  expect(host.textContent).toContain(`v${APP_VERSION}`);
  const check = host.querySelector<HTMLButtonElement>('[aria-label="检查更新"]');
  expect(check).not.toBeNull();
  await act(async () => check!.click());
  expect(checkUpdate).toHaveBeenCalledTimes(1);
  await act(async () => useApp.setState({ updateInfo: { version: '0.3.0', notes: '修复连接', url: 'https://example.com/app.apk', sha256: 'a'.repeat(64) } }));
  expect(host.textContent).toContain('0.3.0');
  const install = host.querySelector<HTMLButtonElement>('[aria-label="下载并安装更新"]');
  expect(install).not.toBeNull();
  await act(async () => install!.click());
  expect(downloadUpdate).toHaveBeenCalledTimes(1);
  await act(async () => useApp.setState({ downloadingUpdate: true }));
  expect(install!.disabled).toBe(true);
  await act(async () => install!.click());
  expect(downloadUpdate).toHaveBeenCalledTimes(1);
});

it('手机订阅页可打开组合，不主动弹出键盘，系统返回只收起弹窗', async () => {
  await render();
  await click('订阅');
  await act(async () => { await vi.dynamicImportSettled(); });
  const entry = host.querySelector<HTMLButtonElement>('[aria-label="组合订阅"]');
  expect(entry).not.toBeNull();
  await act(async () => entry!.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('先添加两份来源订阅');
  expect(document.activeElement?.tagName).not.toBe('INPUT');
  await back();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(currentPage()).toBe('profiles');
});
