// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ResourcesPage } from '../src/pages/Resources';
import { KernelPage } from '../src/pages/Kernel';
import { api } from '../src/core/api';
import { useApp } from '../src/store/app';
import { useViewPreferences } from '../src/store/view-preferences';

const native = vi.hoisted(() => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  return { invoke: vi.fn() };
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
const platform = vi.hoisted(() => ({ linux: false, android: false }));
vi.mock('../src/core/platform', () => ({ get isAndroid() { return platform.android; }, isWindows: false, get isLinux() { return platform.linux; } }));
vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, isTauri: true, api: Object.fromEntries(Object.keys(actual.api).map(key => [key, vi.fn().mockResolvedValue(undefined)])) };
});
let root: Root;
let host: HTMLDivElement;
const notify = vi.fn();
const info = { running: true, version: 'v1.2.3', pid: 1, rssKb: 1024, binary: '/mock/kernel', bundledVersion: 'v1.2.3' };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === label || (label === '刷新' && b.getAttribute('aria-label')?.startsWith('刷新')))!;
const click = async (element: HTMLElement) => { await act(async () => element.click()); };
const render = async (Page: typeof ResourcesPage | typeof KernelPage) => { await act(async () => root.render(createElement(Page))); };
beforeEach(() => {
  useViewPreferences.setState(useViewPreferences.getInitialState(), true);
  platform.linux = false;
  platform.android = false;
  vi.useFakeTimers(); vi.resetAllMocks();
  native.invoke.mockResolvedValue(undefined);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  useApp.setState({ ...useApp.getInitialState(), kernelPhase: 'running', notify,
    updateSettings: vi.fn(), applyConfig: vi.fn().mockResolvedValue(true), restartKernel: vi.fn().mockResolvedValue(true) });
  vi.mocked(api.listResourceFiles).mockResolvedValue([{ name: 'geoip.dat', exists: true, size: 1024 }]);
  vi.mocked(api.mihomo).mockResolvedValue({ providers: {} });
  vi.mocked(api.kernelInfo).mockResolvedValue(info);
  vi.mocked(api.listKernelVersions).mockResolvedValue([]);
  vi.mocked(api.systemHelperInfo).mockResolvedValue({ installed: false, version: null, needsUpdate: false, path: '/mock' });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

it('Android资源页保留更新入口，隐藏不可用的桌面目录入口', async () => {
  platform.android = true;
  await render(ResourcesPage);
  expect(host.querySelector('[aria-label="打开资源目录"]')).toBeNull();
  expect(host.querySelector('[aria-label="刷新资源"]')).not.toBeNull();
  expect(api.openDataDir).not.toHaveBeenCalled();
});

it('局域网认证或监听未就绪时不能开启，条件齐全后才可开启', async () => {
  await render(KernelPage);
  const control = () => host.querySelector<HTMLButtonElement>('[aria-label="允许局域网连接"]')!;
  expect(control().disabled).toBe(true);
  expect(control().getAttribute('aria-checked')).toBe('false');
  await act(async () => useApp.setState(state => ({ settings: { ...state.settings, authUser: 'user', authPass: 'pass', bindAddress: '0.0.0.0' } })));
  expect(control().disabled).toBe(false);
});

it('内核返回 null 提供者映射时表示空列表，不显示读取失败', async () => {
  vi.mocked(api.mihomo).mockResolvedValue({ providers: null });
  await render(ResourcesPage);
  expect(host.querySelector('.dp-resource-summary')?.textContent).not.toContain('读取失败');
  await click([...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent?.startsWith('规则集'))!);
  expect(host.textContent).toContain('未引用独立规则集');
  expect(host.querySelector('.read-error')).toBeNull();
});

it('缺少提供者字段仍报告真实格式错误，不把损坏响应当作空列表', async () => {
  vi.mocked(api.mihomo).mockResolvedValue({});
  await render(ResourcesPage);
  expect(host.querySelector('.dp-resource-summary')?.textContent).toContain('规则集读取失败');
  await click([...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent?.startsWith('规则集'))!);
  expect(host.querySelector('.read-error')?.textContent).toContain('格式异常');
  expect(host.textContent).not.toContain('未引用独立规则集');
});

it('关闭的 SOCKS 端口显示建议值，只有显式开启才应用，关闭保留本次选择', async () => {
  useApp.setState({ updateSettings: useApp.getInitialState().updateSettings });
  await render(KernelPage);
  const field = () => host.querySelector<HTMLInputElement>('[aria-label="SOCKS 端口"]')!;
  const toggle = () => host.querySelector<HTMLButtonElement>('[aria-label="启用 SOCKS 端口"]')!;
  expect(useApp.getState().settings.socksPort).toBe(0);
  expect(field().value).toBe('7891');
  expect(field().disabled).toBe(true);
  await click(toggle());
  expect(useApp.getState().settings.socksPort).toBe(7891);
  expect(field().disabled).toBe(false);
  await click(toggle());
  expect(useApp.getState().settings.socksPort).toBe(0);
  expect(field().value).toBe('7891');
});

it('开启可选端口失败时保持关闭，不把建议值写成已生效端口', async () => {
  useApp.setState({ updateSettings: useApp.getInitialState().updateSettings });
  vi.mocked(useApp.getState().applyConfig).mockResolvedValue(false);
  await render(KernelPage);
  await click(host.querySelector<HTMLButtonElement>('[aria-label="启用 HTTP 端口"]')!);
  expect(useApp.getState().settings.httpPort).toBe(0);
  expect(host.querySelector('[aria-label="启用 HTTP 端口"]')?.getAttribute('aria-checked')).toBe('false');
  expect(host.querySelector<HTMLInputElement>('[aria-label="HTTP 端口"]')?.disabled).toBe(true);
});

it('资源读取分别失败仍保留成功列表，失败不伪装空数据', async () => {
  vi.mocked(api.listResourceFiles).mockRejectedValue(new Error('disk denied'));
  vi.mocked(api.mihomo).mockImplementation(async (_method, path) => {
    if (path === '/providers/rules') throw new Error('rules offline');
    return { providers: { Airport: { vehicleType: 'HTTP', proxies: ['A'] } } };
  });
  await render(ResourcesPage);
  expect(host.textContent).toContain('disk denied');
  expect(host.textContent).not.toContain('缺失');
  await click(button('规则集'));
  expect(host.textContent).toContain('rules offline');
  expect(host.textContent).not.toContain('未引用独立规则集');
  await click([...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent?.startsWith('节点来源'))!);
  expect(host.textContent).toContain('Airport');
});

it('资源说明区分文件下载与实际引用，数据源选择不影响 GeoSite 和 ASN', async () => {
  await render(ResourcesPage);
  expect(host.querySelector('.dp-resource-heading-icon')).toBeNull();
  expect(host.querySelector('.geo-source-list')?.textContent).toContain('已下载');
  expect(host.querySelector('[aria-label="MetaDB 数据库 在线源"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="兼容 MMDB 数据库 在线源"]')).not.toBeNull();
  const source = host.querySelector<HTMLElement>('[aria-label="GeoData 数据模式"]')!;
  expect(host.textContent).toContain('db 使用 MetaDB / MMDB，dat 使用 GeoIP.dat；GeoSite、ASN 独立按需加载，已下载不代表正在使用。');
  await click([...source.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'dat')!);
  expect(useApp.getState().updateSettings).toHaveBeenCalledWith({ geoDataMode: 'dat' });
  expect(notify).toHaveBeenCalledWith('info', 'GeoData 数据模式已保存，重启内核后生效');
});

it('资源加载不提前报告缺失，失败刷新标记旧数据并可重试', async () => {
  const pending = deferred<Awaited<ReturnType<typeof api.listResourceFiles>>>();
  vi.mocked(api.listResourceFiles).mockReturnValueOnce(pending.promise);
  await render(ResourcesPage);
  expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(host.textContent).not.toContain('缺失');
  await act(async () => pending.resolve([{ name: 'geoip.dat', exists: true, size: 1024 }]));
  vi.mocked(api.listResourceFiles).mockRejectedValueOnce(new Error('read interrupted'));
  await click(button('刷新'));
  expect(host.textContent).toContain('上次');
  expect(host.textContent).toContain('read interrupted');
  await click(button('重试'));
  expect(host.textContent).not.toContain('read interrupted');
});

it('资源错误摘要指向失败分类，切换后重试读取且保留其他成功数据', async () => {
  vi.mocked(api.mihomo).mockImplementation(async (_method, path) => {
    if (path === '/providers/rules') throw new Error('rules offline');
    return { providers: { Airport: { vehicleType: 'HTTP', proxies: ['A'] } } };
  });
  await render(ResourcesPage);
  expect(host.querySelector('.page-sub')?.textContent).toContain('规则集读取失败');
  expect(host.querySelector('.page-sub')?.textContent).not.toContain('分流数据库读取失败');
  expect(host.querySelector('.geo-source-list')?.textContent).toContain('已下载');
  const errorLink = host.querySelector<HTMLButtonElement>('[aria-label="查看规则集读取错误"]');
  expect(errorLink).not.toBeNull();
  const reads = vi.mocked(api.mihomo).mock.calls.length;
  await click(errorLink!);
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('规则集');
  expect(host.querySelector('.read-error')?.textContent).toContain('rules offline');
  expect(api.mihomo).toHaveBeenCalledTimes(reads);
  const pending = deferred<any>();
  vi.mocked(api.mihomo).mockImplementation(async (_method, path) => path === '/providers/rules'
    ? pending.promise : { providers: { Airport: { vehicleType: 'HTTP', proxies: ['A'] } } });
  const retry = button('重试');
  await click(retry);
  expect(retry.disabled).toBe(true);
  expect(host.querySelector<HTMLButtonElement>('[aria-label="刷新资源"]')!.disabled).toBe(true);
  const retryReads = vi.mocked(api.mihomo).mock.calls.length;
  await click(retry);
  expect(api.mihomo).toHaveBeenCalledTimes(retryReads);
  await act(async () => pending.resolve({ providers: { Rules: { vehicleType: 'HTTP', ruleCount: 12 } } }));
  expect(host.querySelector('.page-sub')?.textContent).not.toContain('读取失败');
  expect(host.textContent).toContain('Rules');
  await click([...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent?.startsWith('节点来源'))!);
  expect(host.textContent).toContain('Airport');
});

it('多个资源类型读取失败时页头逐项指出，分流数据库错误也可直接定位', async () => {
  vi.mocked(api.listResourceFiles).mockRejectedValue(new Error('disk denied'));
  vi.mocked(api.mihomo).mockRejectedValue(new Error('controller offline'));
  await render(ResourcesPage);
  const summary = host.querySelector('.page-sub')!;
  expect(summary.textContent).toContain('分流数据库读取失败');
  expect(summary.textContent).toContain('规则集读取失败');
  expect(summary.textContent).toContain('节点来源读取失败');
  await click(host.querySelector<HTMLElement>('[aria-label="查看节点来源读取错误"]')!);
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('节点来源');
  await click(host.querySelector<HTMLElement>('[aria-label="查看分流数据库读取错误"]')!);
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('分流数据库');
  expect(host.querySelector('.read-error')?.textContent).toContain('disk denied');
  expect(button('重试').disabled).toBe(false);
});

it('提供者批量更新全程锁定且准确汇报部分失败', async () => {
  const pending = deferred<unknown>();
  vi.mocked(api.mihomo).mockImplementation(async (method, path) => {
    if (method === 'GET') return { providers: { A: {}, B: {} } };
    if (path.endsWith('/A')) return pending.promise;
    throw new Error('B unavailable');
  });
  await render(ResourcesPage);
  await click([...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent?.startsWith('规则集'))!);
  await click(button('更新当前列表'));
  expect(button('更新当前列表').disabled).toBe(true);
  await click(button('更新当前列表'));
  await act(async () => pending.resolve({}));
  expect(vi.mocked(api.mihomo).mock.calls.filter(([method]) => method === 'PUT')).toHaveLength(2);
  expect(notify.mock.calls.some(([kind, message]) => kind === 'error' && String(message).includes('B'))).toBe(true);
  expect(button('更新当前列表').disabled).toBe(false);
});

it('内核三种读取失败分别可重试，不推断未运行或未安装', async () => {
  vi.mocked(api.kernelInfo).mockRejectedValue(new Error('info unavailable'));
  vi.mocked(api.listKernelVersions).mockRejectedValue(new Error('versions unavailable'));
  vi.mocked(api.systemHelperInfo).mockRejectedValue(new Error('helper unavailable'));
  await render(KernelPage);
  expect(host.textContent).toContain('info unavailable');
  expect(host.textContent).toContain('versions unavailable');
  expect(host.textContent).toContain('helper unavailable');
  expect(host.textContent).not.toContain('未安装');
  expect(host.textContent).not.toContain('未运行');
  vi.mocked(api.kernelInfo).mockResolvedValue(info);
  vi.mocked(api.listKernelVersions).mockResolvedValue([]);
  vi.mocked(api.systemHelperInfo).mockResolvedValue({ installed: true, version: 'v1.2.3', needsUpdate: false, path: '/mock' });
  await click(button('刷新'));
  expect(host.textContent).not.toContain('unavailable');
  expect(host.textContent).toContain('已安装');
});

it('内核手动刷新与定时读取不会重入，后续失败标记旧数据', async () => {
  const pending = deferred<typeof info>();
  vi.mocked(api.kernelInfo).mockReturnValueOnce(pending.promise);
  await render(KernelPage);
  expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
  await click(button('刷新'));
  await act(async () => vi.advanceTimersByTimeAsync(15000));
  expect(api.kernelInfo).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(info));
  vi.mocked(api.kernelInfo).mockRejectedValueOnce(new Error('refresh failed'));
  await click(button('刷新'));
  expect(host.textContent).toContain('上次');
  expect(host.textContent).toContain('refresh failed');
});

it('内核运行设置失败时不报告成功，并锁住连续操作', async () => {
  useApp.setState(state => ({ settings: { ...state.settings, authUser: 'user', authPass: 'pass', bindAddress: '0.0.0.0' } }));
  const pending = deferred<boolean>();
  const apply = vi.fn().mockReturnValue(pending.promise);
  useApp.setState({ applyConfig: apply });
  await render(KernelPage);
  const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="允许局域网连接"]')!;
  await click(toggle); await click(toggle);
  expect(apply).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(false));
  expect(useApp.getState().restartKernel).not.toHaveBeenCalled();
  expect(notify.mock.calls.some(([kind]) => kind === 'info' || kind === 'success')).toBe(false);
});

it('内核后台采样不会禁用正在编辑的端口，提交等读取结束后执行', async () => {
  useApp.setState(state => ({ settings: { ...state.settings, authUser: 'user', authPass: 'pass', bindAddress: '0.0.0.0' } }));
  await render(KernelPage);
  const pending = deferred<typeof info>();
  vi.mocked(api.kernelInfo).mockReturnValueOnce(pending.promise);
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(host.querySelector<HTMLInputElement>('input[aria-label="混合端口"]')!.disabled).toBe(false);
  await click(host.querySelector<HTMLButtonElement>('button[aria-label="允许局域网连接"]')!);
  expect(useApp.getState().applyConfig).not.toHaveBeenCalled();
  await act(async () => pending.resolve(info));
  expect(useApp.getState().applyConfig).toHaveBeenCalledTimes(1);
});

it('提权内核安装返回未安装时不得报告安装成功', async () => {
  vi.mocked(api.installSystemHelper).mockResolvedValue({ installed: false, version: null, needsUpdate: false, path: '/mock' });
  await render(KernelPage);
  await click(button('安装'));
  expect(notify.mock.calls.some(([kind]) => kind === 'success')).toBe(false);
  expect(notify.mock.calls.some(([kind]) => kind === 'error')).toBe(true);
});

it('管理服务就近显示安装状态，已安装时提供真正的重新安装入口', async () => {
  const installed = { installed: true, version: 'v1.2.3', needsUpdate: false, path: '/mock' };
  vi.mocked(api.systemHelperInfo).mockResolvedValue(installed);
  vi.mocked(api.installSystemHelper).mockResolvedValue(installed);
  await render(KernelPage);
  const row = button('重新安装').closest('[role="group"]')!;
  expect(row.textContent).toContain('已安装');
  expect(row.textContent).toContain('v1.2.3');
  expect(button('卸载').disabled).toBe(false);
  await click(button('重新安装'));
  expect(api.installSystemHelper).toHaveBeenCalledOnce();
  expect(notify).toHaveBeenCalledWith('success', 'TUN 提权服务已重新安装');
});

it('Linux 显示网络授权状态并可授权、移除，不使用安装服务的文案', async () => {
  platform.linux = true;
  const installed = { installed: true, version: 'v1.2.3', needsUpdate: false, path: '/mock/mihomo' };
  vi.mocked(api.installSystemHelper).mockResolvedValue(installed);
  vi.mocked(api.uninstallSystemHelper).mockResolvedValue({ ...installed, installed: false });
  await render(KernelPage);
  expect(host.textContent).toContain('TUN 网络授权');
  expect(button('授权').disabled).toBe(false);
  await click(button('授权'));
  expect(notify).toHaveBeenCalledWith('success', 'TUN 网络授权已就绪');
  expect(button('重新授权').closest('[role="group"]')?.textContent).toContain('已授权');
  await click(button('移除授权'));
  await click(button('确认移除'));
  expect(api.uninstallSystemHelper).toHaveBeenCalledOnce();
  expect(notify).toHaveBeenCalledWith('success', '网络授权已移除，下次开启 TUN 时重新授权');
});

it('服务检查期间禁止安装，未安装时才显示安装并禁用卸载', async () => {
  const pending = deferred<Awaited<ReturnType<typeof api.systemHelperInfo>>>();
  vi.mocked(api.systemHelperInfo).mockReturnValueOnce(pending.promise);
  await render(KernelPage);
  expect(button('安装').disabled).toBe(true);
  expect(button('安装').closest('[role="group"]')!.textContent).toContain('检查中');
  await act(async () => pending.resolve({ installed: false, version: null, needsUpdate: false, path: '/mock' }));
  expect(button('安装').disabled).toBe(false);
  expect(button('安装').closest('[role="group"]')!.textContent).toContain('未安装');
  expect(button('卸载').disabled).toBe(true);
});

it('服务可单独刷新，失败不能继续显示已安装或允许操作，重试后恢复', async () => {
  vi.mocked(api.systemHelperInfo).mockResolvedValue({ installed: true, version: 'v1.2.3', needsUpdate: false, path: '/mock' });
  await render(KernelPage);
  const refresh = () => host.querySelector<HTMLButtonElement>('[aria-label="检查服务状态"]')!;
  const calls = vi.mocked(api.kernelInfo).mock.calls.length;
  vi.mocked(api.systemHelperInfo).mockRejectedValueOnce(new Error('权限读取失败'));
  await click(refresh());
  const row = button('重新安装').closest('[role="group"]')!;
  expect(row.querySelector('[role="status"]')?.textContent).toBe('状态未知');
  expect(button('重新安装').disabled).toBe(true);
  expect(button('卸载').disabled).toBe(true);
  expect(api.kernelInfo).toHaveBeenCalledTimes(calls);
  vi.mocked(api.systemHelperInfo).mockResolvedValue({ installed: false, version: null, needsUpdate: false, path: '/mock' });
  await click(refresh());
  expect(button('安装').disabled).toBe(false);
  expect(row.querySelector('[role="status"]')?.textContent).toBe('未安装');
});

async function commitPort(index: number, value: number) {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${index === 0 ? '混合端口' : '控制端口'}"]`)!;
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => input.blur());
}

it.each([
  ['mixedPort', 0, 7891, 'apply'], ['mixedPort', 0, 7891, 'restart'], ['mixedPort', 0, 7891, 'throw'],
  ['controllerPort', 1, 9091, 'apply'], ['controllerPort', 1, 9091, 'restart'], ['controllerPort', 1, 9091, 'throw'],
] as const)('%s 修改在 %s / %s / %s 失败时回滚真实设置和原生目标', async (field, index, nextPort, failure) => {
  const actual = await vi.importActual<typeof import('../src/core/api')>('../src/core/api');
  actual.setMihomoBase(9090);
  vi.mocked(api.setSystemProxy).mockImplementation(actual.api.setSystemProxy);
  useApp.setState({ updateSettings: useApp.getInitialState().updateSettings, sysProxyEnabled: true });
  const previous = useApp.getState().settings[field];
  if (failure === 'throw') vi.mocked(useApp.getState().applyConfig).mockRejectedValueOnce(new Error('write denied'));
  else vi.mocked(failure === 'apply' ? useApp.getState().applyConfig : useApp.getState().restartKernel).mockResolvedValueOnce(false);
  await render(KernelPage);
  await commitPort(index, nextPort);
  expect(useApp.getState().settings[field]).toBe(previous);
  expect(host.querySelector<HTMLInputElement>(`input[aria-label="${index === 0 ? '混合端口' : '控制端口'}"]`)!.value).toBe(String(previous));
  expect(useApp.getState().kernelPhase).toBe('running');
  expect(notify).toHaveBeenCalledWith('error', expect.any(String));
  expect(notify.mock.calls.some(([kind]) => kind === 'info' || kind === 'success')).toBe(false);
  if (field === 'mixedPort') {
    const targets = native.invoke.mock.calls.filter(([command]) => command === 'set_system_proxy').map(([, args]) => args.port);
    expect(targets).toEqual([7891, 7890]);
  } else {
    await actual.api.mihomo('GET', '/version');
    expect(native.invoke).toHaveBeenLastCalledWith('mihomo_request', expect.objectContaining({ base: 'http://127.0.0.1:9090' }));
  }
});

it('没有活动订阅且离线时保留端口设置，并明确提示导入后生效', async () => {
  useApp.setState({ kernelPhase: 'stopped', updateSettings: useApp.getInitialState().updateSettings,
    activeId: 'missing', profiles: [] });
  await render(KernelPage);
  await commitPort(0, 7891);
  expect(useApp.getState().settings.mixedPort).toBe(7891);
  expect(useApp.getState().applyConfig).not.toHaveBeenCalled();
  expect(useApp.getState().restartKernel).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith('info', expect.stringContaining('导入'));
  expect(notify.mock.calls.some(([kind]) => kind === 'error')).toBe(false);
});

it.each([
  ['bindAddress', '监听地址', '0.0.0.0'], ['authUser', '认证用户名', 'user'], ['authPass', '认证密码', 'secret'],
] as const)('%s 应用失败后输入框与已保存设置一致', async (field, label, value) => {
  useApp.setState({ updateSettings: useApp.getInitialState().updateSettings });
  vi.mocked(useApp.getState().applyConfig).mockResolvedValueOnce(false);
  const previous = useApp.getState().settings[field];
  await render(KernelPage);
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => input.blur());
  expect(useApp.getState().settings[field]).toBe(previous);
  expect(host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!.value).toBe(previous);
});

it('提供者筛选是有名称的真实输入，节点来源列表使用共享行结构', async () => {
  vi.mocked(api.mihomo).mockResolvedValue({ providers: { Airport: { vehicleType: 'HTTP', proxies: ['A'] } } } as any);
  await render(ResourcesPage);
  await click([...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent?.startsWith('节点来源'))!);
  const filter = host.querySelector<HTMLInputElement>('[aria-label="搜索资源"]')!;
  expect(filter).toBeTruthy(); expect(filter.tagName).toBe('INPUT');
  expect(host.querySelector('.resource-provider')).not.toBeNull();
  expect(host.textContent).toContain('Airport');
});


it('下载版本只加入本地列表，不改变当前选用的内核', async () => {
  const downloaded = { name: 'v1.20.0', version: '1.20.0', path: '/mock/kernels/v1.20.0/mihomo', builtin: false, size: 61000000 };
  vi.mocked(api.downloadKernelVersion).mockResolvedValue(downloaded);
  await render(KernelPage);
  await click(host.querySelector<HTMLButtonElement>('[aria-label="下载稳定版"]')!);
  expect(api.downloadKernelVersion).toHaveBeenCalledTimes(1);
  expect(useApp.getState().updateSettings).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith('success', expect.stringContaining('可在「使用版本」中切换'));
});

it('已安装版本收进下拉选择，切换只更新选用路径，不自动重启', async () => {
  vi.mocked(api.listKernelVersions).mockResolvedValue([
    { name: '内置内核', version: 'v1.2.3', path: '/mock/kernel', builtin: true, size: 60000000 },
    { name: 'v1.20.0', version: '1.20.0', path: '/mock/v1.20.0/mihomo', builtin: false, size: 61000000 },
  ]);
  await render(KernelPage);
  expect(host.querySelector('[aria-label="已安装内核版本"]')).toBeNull();
  await click(host.querySelector<HTMLButtonElement>('[aria-label="使用版本"]')!);
  await click([...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(b => b.textContent?.includes('v1.20.0'))!);
  expect(useApp.getState().updateSettings).toHaveBeenCalledWith({ kernelPath: '/mock/v1.20.0/mihomo' });
  expect(useApp.getState().restartKernel).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith('info', '已选用，重启内核后生效');
});

it('自定义路径在版本选择中有对应选项，也可切回内置版本', async () => {
  useApp.setState(state => ({ settings: { ...state.settings, kernelPath: '/custom/mihomo' } }));
  vi.mocked(api.listKernelVersions).mockResolvedValue([
    { name: '内置内核', version: 'v1.2.3', path: '/mock/kernel', builtin: true, size: 60000000 },
  ]);
  await render(KernelPage);
  expect(host.querySelector('[aria-label="使用版本"]')?.textContent).toContain('自定义路径');
  await click(host.querySelector<HTMLButtonElement>('[aria-label="使用版本"]')!);
  await click([...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(b => b.textContent?.includes('内置'))!);
  expect(useApp.getState().updateSettings).toHaveBeenCalledWith({ kernelPath: '' });
});

it('特定版本弹窗按需读取、搜索和选择，下载不自动切换', async () => {
  vi.mocked(api.listKernelReleases).mockRejectedValueOnce(new Error('rate limited')).mockResolvedValue([
    { version: 'v1.20.0', publishedAt: null }, { version: 'v1.19.0', publishedAt: null },
  ]);
  vi.mocked(api.downloadKernelVersion).mockResolvedValue({ name: 'v1.20.0', version: '1.20.0', path: '/mock/v1.20.0/mihomo', builtin: false, size: 61000000 });
  await render(KernelPage);
  expect(api.listKernelReleases).not.toHaveBeenCalled();
  await click(host.querySelector<HTMLButtonElement>('[aria-label="选择特定版本"]')!);
  expect(document.body.textContent).toContain('rate limited');
  await click(document.body.querySelector<HTMLButtonElement>('[aria-label="刷新内核版本列表"]')!);
  const search = document.body.querySelector<HTMLInputElement>('[aria-label="搜索内核版本"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '1.20'); search.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(document.body.querySelector('[aria-label="选择 v1.19.0"]')).toBeNull();
  await click(document.body.querySelector<HTMLButtonElement>('[aria-label="选择 v1.20.0"]')!);
  await click([...document.body.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '下载版本')!);
  expect(api.downloadKernelVersion).toHaveBeenCalledWith('http://127.0.0.1:7890', undefined, 'v1.20.0');
  expect(useApp.getState().updateSettings).not.toHaveBeenCalled();
});

it('预览版通道只在点击下载后获取官方 Alpha 内核', async () => {
  vi.mocked(api.downloadKernelVersion).mockResolvedValue({ name: 'alpha-abcdef0', version: 'alpha-abcdef0', path: '/mock/alpha/mihomo', builtin: false, size: 61000000 });
  await render(KernelPage);
  await click(host.querySelector<HTMLButtonElement>('[aria-label="内核更新通道"]')!);
  await click([...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(b => b.textContent?.includes('预览版'))!);
  expect(api.downloadKernelVersion).not.toHaveBeenCalled();
  await click(host.querySelector<HTMLButtonElement>('[aria-label="下载预览版"]')!);
  expect(api.downloadKernelVersion).toHaveBeenCalledWith('http://127.0.0.1:7890', undefined, 'Prerelease-Alpha');
});

it('选用和运行中的版本不能删除，其他本地版本需要确认后删除', async () => {
  const versions = [
    { name: '内置内核', version: 'v1.2.3', path: '/mock/kernel', builtin: true, size: 60000000 },
    { name: 'v1.20.0', version: '1.20.0', path: '/mock/v1.20.0/mihomo', builtin: false, size: 61000000 },
    { name: 'v1.19.0', version: '1.19.0', path: '/mock/v1.19.0/mihomo', builtin: false, size: 59000000 },
    { name: 'v1.18.0', version: '1.18.0', path: '/mock/v1.18.0/mihomo', builtin: false, size: 58000000 },
  ];
  vi.mocked(api.kernelInfo).mockResolvedValue({ ...info, binary: versions[2].path });
  useApp.setState(state => ({ settings: { ...state.settings, kernelPath: versions[1].path } }));
  vi.mocked(api.listKernelVersions).mockResolvedValue(versions);
  await render(KernelPage);
  await click(host.querySelector<HTMLButtonElement>('[aria-label="管理本地版本"]')!);
  expect(host.querySelector('[aria-label="删除 v1.2.3"]')).toBeNull();
  expect(document.body.querySelector<HTMLButtonElement>('[aria-label="删除 v1.20.0"]')?.disabled).toBe(true);
  expect(document.body.querySelector<HTMLButtonElement>('[aria-label="删除 v1.19.0"]')?.disabled).toBe(true);
  await click(document.body.querySelector<HTMLButtonElement>('[aria-label="删除 v1.18.0"]')!);
  expect(api.removeKernelVersion).not.toHaveBeenCalled();
  await click(document.body.querySelector<HTMLButtonElement>('[aria-label="确认删除 v1.18.0"]')!);
  expect(api.removeKernelVersion).toHaveBeenCalledWith(versions[3].path);
});

it('资源胶囊 tabs 支持方向键切换并将焦点移到新标签', async () => {
  await render(ResourcesPage);
  const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  tabs[0].focus();
  await act(async () => { tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
  expect(tabs[1].getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(tabs[1]);
  expect(host.querySelector('[role="tabpanel"]')?.getAttribute('aria-label')).toBe('规则集');
});

it('节点来源已更新但节点快照读取失败时保留成功结果并给出重试提示', async () => {
  vi.mocked(api.mihomo).mockImplementation(async (method) => method === 'GET' ? { providers: { Airport: { vehicleType: 'HTTP', proxies: ['A'] } } } : {});
  useApp.setState({ refreshGroups: vi.fn().mockRejectedValue(new Error('snapshot offline')), refreshProxyProviders: vi.fn().mockResolvedValue(true) });
  await render(ResourcesPage);
  await click([...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent?.startsWith('节点来源'))!);
  await click(host.querySelector<HTMLButtonElement>('[aria-label="更新 Airport"]')!);
  expect(host.textContent).toContain('Airport');
  expect(notify).toHaveBeenCalledWith('info', expect.stringContaining('节点列表暂未同步'));
  expect(host.querySelector<HTMLButtonElement>('[aria-label="更新 Airport"]')?.disabled).toBe(false);
});

it('等待版本列表时可关闭弹窗，返回结果缓存且不打断主页面', async () => {
  const request = deferred<Array<{ version: string; publishedAt: null }>>();
  vi.mocked(api.listKernelReleases).mockReturnValue(request.promise);
  await render(KernelPage);
  const open = () => host.querySelector<HTMLButtonElement>('[aria-label="选择特定版本"]')!;
  await click(open());
  await click(document.body.querySelector<HTMLButtonElement>('[aria-label="关闭版本选择"]')!);
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(host.querySelector<HTMLButtonElement>('[aria-label="下载稳定版"]')?.disabled).toBe(false);
  await act(async () => request.resolve([{ version: 'v1.20.0', publishedAt: null }]));
  await click(open());
  expect(document.body.querySelector('[aria-label="选择 v1.20.0"]')).not.toBeNull();
  expect(api.listKernelReleases).toHaveBeenCalledTimes(1);
});

it('版本分页失败保留已有结果，重试相同页并合并去重', async () => {
  vi.mocked(api.listKernelReleases).mockResolvedValueOnce([{ version: 'v1.20.0', publishedAt: null }])
    .mockRejectedValueOnce(new Error('page offline')).mockResolvedValueOnce([{ version: 'v1.20.0', publishedAt: null }, { version: 'v1.19.0', publishedAt: null }]);
  await render(KernelPage);
  await click(host.querySelector<HTMLButtonElement>('[aria-label="选择特定版本"]')!);
  await click([...document.body.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '加载更多版本')!);
  expect(document.body.querySelector('[aria-label="选择 v1.20.0"]')).not.toBeNull();
  expect(document.body.textContent).toContain('page offline');
  await click(document.body.querySelector<HTMLButtonElement>('.read-error button')!);
  expect(document.body.querySelectorAll('[aria-label="选择 v1.20.0"]')).toHaveLength(1);
  expect(document.body.querySelector('[aria-label="选择 v1.19.0"]')).not.toBeNull();
  expect(api.listKernelReleases).toHaveBeenLastCalledWith('http://127.0.0.1:7890', 2);
});
