// @vitest-environment happy-dom
import { act, createElement, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConnectionsPage } from '../src/pages/Connections';
import { LogsPage } from '../src/pages/Logs';
import { TrafficPage } from '../src/pages/Traffic';
import { save } from '@tauri-apps/plugin-dialog';
import { useViewPreferences } from '../src/store/view-preferences';

const mock = vi.hoisted(() => ({ mihomo: vi.fn(), readKernelLog: vi.fn(), notify: vi.fn(), resolveProcessIcon: vi.fn(), exportLogFile: vi.fn() }));
vi.mock('../src/core/api', () => ({ isTauri: true, api: mock }));
vi.mock('../src/store/app', () => {
  const state = { kernelPhase: 'running', notify: mock.notify, settings: { textSize: 'standard' } };
  return { useApp: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }) };
});
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));

let root: Root; let host: HTMLDivElement;
const connection = (id: string) => ({ id, start: '2026-11-07T00:00:00Z', upload: 10, download: 20, metadata: { host: `${id}.example`, process: 'Browser' }, chains: ['Node A'] });
const snapshot = (ids = ['one', 'two']) => ({ connections: ids.map(connection), uploadTotal: 20, downloadTotal: 40 });
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label)!;
const click = async (target: HTMLElement) => act(async () => target.click());
const render = async (Page: ComponentType<{ active?: boolean }>, active = true) => act(async () => root.render(createElement(Page, { active })));
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

beforeEach(() => {
  useViewPreferences.setState(useViewPreferences.getInitialState(), true);
  vi.useFakeTimers(); vi.resetAllMocks();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  mock.mihomo.mockResolvedValue(snapshot()); mock.readKernelLog.mockResolvedValue('level=info hello'); mock.resolveProcessIcon.mockResolvedValue(null);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

it.each([['连接', ConnectionsPage], ['流量', TrafficPage], ['日志', LogsPage]] as const)('%s 初次慢请求显示加载，失败不冒充空数据，重试成功才显示空态', async (name, Page) => {
  const request = deferred<any>(); const api = name === '日志' ? mock.readKernelLog : mock.mihomo;
  api.mockReturnValueOnce(request.promise);
  await render(Page);
  expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
  await act(async () => request.reject(new Error('mock read failed')));
  expect(host.textContent).toContain('读取失败');
  expect(host.textContent).not.toContain(name === '日志' ? '暂无日志' : '暂无活动连接');
  api.mockResolvedValueOnce(name === '日志' ? '' : snapshot([]));
  await click(button('重试'));
  expect(host.textContent).not.toContain('读取失败');
  expect(host.textContent).toContain(name === '日志' ? '暂无日志' : '暂无活动连接');
});

it.each([['连接', ConnectionsPage], ['流量', TrafficPage], ['日志', LogsPage]] as const)('%s 轮询失败保留旧数据并标明，隐藏时不继续请求', async (name, Page) => {
  await render(Page);
  const api = name === '日志' ? mock.readKernelLog : mock.mihomo;
  api.mockRejectedValue(new Error('offline'));
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(host.textContent).toContain('上次');
  expect(host.textContent).toContain(name === '连接' ? 'one.example' : name === '流量' ? 'Node A' : 'hello');
  await render(Page, false); const count = api.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(20_000));
  expect(api).toHaveBeenCalledTimes(count);
});

it('连接慢请求期间刷新和轮询不重复发送', async () => {
  const request = deferred<any>(); mock.mihomo.mockReturnValueOnce(request.promise);
  await render(ConnectionsPage);
  const refresh = host.querySelector<HTMLButtonElement>('[aria-label="刷新"]')!;
  expect(refresh.disabled).toBe(true);
  await click(refresh); await act(async () => vi.advanceTimersByTimeAsync(6000));
  expect(mock.mihomo).toHaveBeenCalledTimes(1);
  await act(async () => request.resolve(snapshot()));
  expect(refresh.disabled).toBe(false);
});

it('关闭进程部分失败只移除成功连接，并报告失败数量', async () => {
  mock.mihomo.mockImplementation(async (method: string, path: string) => {
    if (method === 'GET') return snapshot();
    if (path.endsWith('/two')) throw new Error('mock close failed');
    return {};
  });
  await render(ConnectionsPage); await click(button('按进程'));
  await click(button('关闭进程连接')); await click(button('确认关闭'));
  expect(mock.notify).toHaveBeenCalledWith('error', expect.stringContaining('1 条失败'));
  await click(button('连接'));
  expect(host.textContent).toContain('two.example'); expect(host.textContent).not.toContain('one.example');
});

it('单项关闭期间锁住其它关闭操作，旧读取结果不能恢复已关闭连接', async () => {
  const read = deferred<any>(); const close = deferred<any>();
  await render(ConnectionsPage);
  mock.mihomo.mockImplementation((method: string) => method === 'GET' ? read.promise : close.promise);
  await click(host.querySelector<HTMLButtonElement>('[aria-label="刷新"]')!);
  const closeButtons = host.querySelectorAll<HTMLButtonElement>('[aria-label="断开此连接"]');
  await click(closeButtons[0]);
  expect(closeButtons[1].disabled).toBe(true); expect(button('关闭所有连接').disabled).toBe(true);
  await click(closeButtons[1]);
  expect(mock.mihomo.mock.calls.filter(([method]) => method === 'DELETE')).toHaveLength(1);
  await act(async () => close.resolve({}));
  await act(async () => read.resolve(snapshot()));
  expect(host.textContent).not.toContain('one.example'); expect(host.textContent).toContain('two.example');
});

it('日志筛选无结果可一键恢复，并公开当前筛选与暂停状态', async () => {
  await render(LogsPage); await click(button('错误'));
  expect(button('错误').getAttribute('aria-pressed')).toBe('true');
  expect(host.textContent).toContain('没有匹配的日志');
  await click(button('清除筛选'));
  expect(host.textContent).toContain('hello'); expect(button('全部').getAttribute('aria-pressed')).toBe('true');
  await click(button('暂停'));
  expect(button('继续刷新').getAttribute('aria-pressed')).toBe('true');
});

it.each([['连接', ConnectionsPage], ['流量', TrafficPage], ['日志', LogsPage]] as const)('%s 隐藏前的慢请求不会覆盖恢复后的读取', async (name, Page) => {
  const request = deferred<any>(); const api = name === '日志' ? mock.readKernelLog : mock.mihomo;
  api.mockReturnValueOnce(request.promise);
  await render(Page); await render(Page, false); await render(Page, true);
  expect(api).toHaveBeenCalledTimes(1);
  await act(async () => request.resolve(name === '日志' ? 'level=info stale' : snapshot(['stale'])));
  expect(host.textContent).not.toContain('stale');
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(host.textContent).toContain(name === '日志' ? 'hello' : name === '连接' ? 'one.example' : 'Node A');
});

it('连接筛选无结果可清除，并保留视图与排序状态', async () => {
  await render(ConnectionsPage);
  const input = host.querySelector<HTMLInputElement>('[aria-label="搜索连接"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'missing');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(host.textContent).toContain('没有匹配的连接');
  await click(button('清除筛选'));
  expect(host.textContent).toContain('one.example');
  expect(button('连接').getAttribute('aria-pressed')).toBe('true');
  expect(button('时间').getAttribute('aria-pressed')).toBe('true');
});

it('结构化日志区分时间、级别与正文，原始模式无损显示；级别筛选不受正文里的 level= 干扰', async () => {
  const raw = 'time="2026-11-08T12:34:56.123Z" level=warning msg="dial level=error failed" retry=3';
  mock.readKernelLog.mockResolvedValue(raw);
  await render(LogsPage);
  expect(host.querySelector('.log-time')?.textContent).toBe('12:34:56');
  expect(host.querySelector('.log-level')?.textContent).toBe('警告');
  expect(host.querySelector('.log-content')?.textContent).toContain('dial level=error failed');
  expect(host.querySelector('.log-details')?.textContent).toBe('retry=3');
  await click(button('原始日志'));
  expect(host.querySelector('.log-plain')?.textContent).toBe(raw);
  await click(button('错误')); expect(host.textContent).toContain('没有匹配的日志');
  await click(button('警告')); expect(host.querySelector('.log-plain')?.textContent).toBe(raw);
});


it('结构化与原始视图都按当前筛选导出原始日志，不改时间精度或丢附加字段', async () => {
  const warning = 'time="2026-11-08T12:34:56.123456789Z" level=warning msg="timeout" retry=3';
  mock.readKernelLog.mockResolvedValue(warning + '\nlevel=info msg="connected"');
  vi.mocked(save).mockResolvedValue('/mock/logs.log'); mock.exportLogFile.mockResolvedValue(undefined);
  await render(LogsPage); await click(button('警告')); await click(button('导出'));
  expect(mock.exportLogFile).toHaveBeenLastCalledWith('/mock/logs.log', warning + '\n');
  await click(button('原始日志')); await click(button('导出'));
  expect(mock.exportLogFile).toHaveBeenLastCalledWith('/mock/logs.log', warning + '\n');
});

it('特殊 Go 转义回退原文后仍能筛选并导出 warning；正文中的 level= 不冒充级别', async () => {
  const raw = String.raw`time="2026-11-08T12:34:56Z" msg="invalid byte \x00 and level=error from upstream" level="warning" retry=3`;
  mock.readKernelLog.mockResolvedValue(raw);
  vi.mocked(save).mockResolvedValue('/mock/logs.log'); mock.exportLogFile.mockResolvedValue(undefined);
  await render(LogsPage); await click(button('警告'));
  expect(host.querySelector('.log-plain')?.textContent).toBe(raw);
  await click(button('导出'));
  expect(mock.exportLogFile).toHaveBeenCalledWith('/mock/logs.log', raw + '\n');
  await click(button('错误')); expect(host.textContent).toContain('没有匹配的日志');
});

it.each([['连接', ConnectionsPage], ['日志', LogsPage]] as const)('%s 搜索框是有名称的真实输入，Escape 清空搜索词', async (name, Page) => {
  await render(Page);
  const input = host.querySelector<HTMLInputElement>(name === '连接' ? '[aria-label="搜索连接"]' : '[aria-label="搜索日志"]')!;
  expect(input).toBeTruthy(); expect(input.tagName).toBe('INPUT');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'zzz');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(host.textContent).toContain(name === '连接' ? '没有匹配的连接' : '没有匹配的日志');
  input.focus();
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(input.value).toBe('');
  expect(host.textContent).toContain(name === '连接' ? 'one.example' : 'hello');
});

it('日志刷新状态是实时区域，读取中、暂停与自动刷新都可被播报', async () => {
  const request = deferred<any>(); mock.readKernelLog.mockReturnValueOnce(request.promise);
  await render(LogsPage);
  const status = () => host.querySelector<HTMLElement>('.dp-log-status[role="status"]')!;
  expect(status()).not.toBeNull(); expect(status().textContent).toBe('读取中…');
  await act(async () => request.resolve('level=info hello'));
  expect(status().textContent).toBe('自动刷新');
  await click(button('暂停'));
  expect(status().textContent).toBe('已暂停');
});

it.each([['连接', ConnectionsPage], ['流量', TrafficPage], ['日志', LogsPage]] as const)('%s 旧数据提示是实时区域并注明上次读取', async (name, Page) => {
  await render(Page);
  const api = name === '日志' ? mock.readKernelLog : mock.mihomo;
  api.mockRejectedValue(new Error('offline'));
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  const notice = host.querySelector<HTMLElement>('.read-error[role="status"]')!;
  expect(notice).not.toBeNull();
  expect(notice.textContent).toContain('上次'); expect(notice.textContent).toContain('offline');
});
