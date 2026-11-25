// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ProxiesPage } from '../src/pages/Proxies';
import { OverviewPage } from '../src/pages/Overview';
import { useApp } from '../src/store/app';
import { useViewPreferences } from '../src/store/view-preferences';
import { api } from '../src/core/api';
import { DEFAULT_LATENCY_URL, GITHUB_LATENCY_URL } from '../src/core/latency';

vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, isTauri: true, api: Object.fromEntries(Object.keys(actual.api).map(key => [key, vi.fn().mockResolvedValue(undefined)])) };
});
const initial = useApp.getInitialState();
let host: HTMLDivElement; let root: Root;
const groups = () => ['常规', '开发'].map(name => ({ name, type: 'Selector', now: 'A', nodes: [{ name: 'A', type: 'Shadowsocks', delay: 999 }] }));
const section = (name: string) => [...host.querySelectorAll<HTMLElement>('.proxy-group')].find(el => el.getAttribute('aria-label') === name)!;
const viewGroup = async (name: string) => act(async () => {
  [...host.querySelectorAll<HTMLButtonElement>('.proxy-group-nav')].find(button => button.getAttribute('aria-label') === `查看分组 ${name}`)?.click();
});
const testGroup = async (name: string) => { await viewGroup(name); await act(async () => section(name).querySelector<HTMLButtonElement>('.proxy-group-actions button')!.click()); };
const reportedGithub = (delay: number) => ({ extra: { [GITHUB_LATENCY_URL]: { Alive: true, History: [{ delay }] } } });
const delayCalls = () => vi.mocked(api.mihomo).mock.calls.filter(([, path]) => String(path).includes('/delay?'));
const respondToLatency = async (_method: string, path: string) => String(path).includes('/delay?')
  ? { delay: String(path).includes(encodeURIComponent(GITHUB_LATENCY_URL)) ? 82 : 21 }
  : reportedGithub(82);
beforeEach(() => {
  useViewPreferences.setState(useViewPreferences.getInitialState(), true);
  vi.clearAllMocks(); localStorage.clear();
  vi.mocked(api.mihomo).mockReset();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem('ppclash.proxy.groups.open', JSON.stringify({ 常规: true, 开发: true }));
  useApp.setState({ ...initial, groups: groups(), kernelPhase: 'running', activeId: 'fixture', notify: vi.fn(),
    profiles: [{ id: 'fixture', name: '测试订阅', raw: '', url: '', updatedAt: 0, userinfo: null, updateIntervalHours: null }] });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('旗标调用固定使用动作，点击不会冒泡为第二次普通选择', async () => {
  const fixed = vi.fn(async () => true); const select = vi.fn();
  useApp.setState({ toggleFixedNode: fixed, selectNode: select });
  await act(async () => root.render(createElement(ProxiesPage)));
  const flag = host.querySelector<HTMLButtonElement>('[aria-label="固定使用 A"]')!;
  expect(flag).not.toBeNull();
  await act(async () => flag.click());
  expect(fixed).toHaveBeenCalledWith('常规', 'A'); expect(select).not.toHaveBeenCalled();
  const row = flag.closest('.proxy-node')!;
  await act(async () => row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  expect(fixed).toHaveBeenCalledTimes(1);
});

it('旧收藏不冒充当前出口，固定与当前分别展示', async () => {
  useApp.setState(s => ({ pinnedNodes: { 常规: ['B'] }, fixedNodes: { fixture: { 常规: 'B' } },
    groups: s.groups.map(g => ({ ...g, nodes: [...g.nodes, { name: 'B', type: 'Shadowsocks', delay: 20 }] })) }));
  await act(async () => root.render(createElement(ProxiesPage)));
  const fixed = section('常规').querySelector<HTMLButtonElement>('[aria-label="取消固定 B"]')!.closest('.proxy-node')!;
  const current = section('常规').querySelector<HTMLButtonElement>('[aria-label="固定使用 A"]')!.closest('.proxy-node')!;
  expect(fixed.classList.contains('selected')).toBe(false);
  expect(fixed.classList.contains('pinned')).toBe(false);
  expect(fixed.querySelector('.node-state.fixed')?.textContent).toBe('固定');
  expect(current.classList.contains('selected')).toBe(true);
  expect(current.querySelector('.node-state.current')?.textContent).toBe('当前');
});

it('自动组旗标禁用并解释不能固定，不静默重启', async () => {
  useApp.setState(s => ({ groups: s.groups.map(g => ({ ...g, type: 'URLTest' })) }));
  await act(async () => root.render(createElement(ProxiesPage)));
  const flag = section('常规').querySelector<HTMLButtonElement>('[aria-label="固定使用 A"]')!;
  expect(flag.disabled).toBe(true); expect(flag.title).toContain('暂不支持固定使用');
});

it('已导入且没有配额时仍显示订阅名称', async () => {
  await act(async () => root.render(createElement(OverviewPage, { active: false })));
  expect(host.querySelector('.quota-card-name')?.textContent).toBe('测试订阅');
  expect(host.querySelector('.quota-card')?.textContent).not.toContain('未导入订阅');
});

it('内核仍运行但更新回退未确认时，概览明确提示未知状态', async () => {
  useApp.setState({ kernelError: '订阅更新回退未确认，请检查运行配置后重新连接', groups: [], routing: null });
  await act(async () => root.render(createElement(OverviewPage, { active: false })));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('回退未确认');
  expect(host.textContent).not.toContain('启动失败');
});

it('隐藏概览后不再派发整组测速剩余队列', async () => {
  const finish: Array<(delay: number) => void> = [];
  const testDelay = vi.fn(() => new Promise<number>(resolve => finish.push(resolve)));
  const nodes = Array.from({ length: 6 }, (_, i) => ({ name: `N${i}`, type: 'Shadowsocks', delay: 12 }));
  useApp.setState({ groups: [{ name: 'Main', type: 'Selector', now: 'N0', nodes }], routing: { primary: 'Main', managed: ['Main'], roots: ['Main'] }, testDelay, refreshGroups: vi.fn(async () => true) });
  await act(async () => root.render(createElement(OverviewPage, { active: true })));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="测速当前分组"]')!.click());
  expect(testDelay).toHaveBeenCalledTimes(3);
  await act(async () => root.render(createElement(OverviewPage, { active: false })));
  await act(async () => finish.splice(0).forEach(resolve => resolve(12)));
  expect(testDelay).toHaveBeenCalledTimes(3);
});

it('已有健康检查 Google 延迟直接用于概览和节点列表，GitHub 保持独立', async () => {
  useApp.setState({ routing: { primary: '常规', managed: ['常规', '开发'] } });
  vi.mocked(api.mihomo).mockResolvedValue({ proxies: {
    常规: { type: 'Selector', now: 'A', all: ['A'] }, 开发: { type: 'Selector', now: 'A', all: ['A'] },
    A: { type: 'Shadowsocks', history: [{ delay: 395 }], extra: {
      'https://www.google.com/generate_204': { alive: true, history: [{ delay: 234 }] },
      'https://chatgpt.com/': { alive: true, history: [{ delay: 395 }] },
    } },
  } });
  await useApp.getState().refreshGroups();
  await act(async () => root.render(createElement(OverviewPage, { active: false })));
  expect(host.querySelector('.hero-gauge')?.getAttribute('aria-label')).toContain('234');
  expect(host.querySelector('.group-card')?.textContent).toContain('234 ms');
  expect(useApp.getState().groups.find(g => g.name === '开发')!.nodes[0].delay).toBeNull();
  expect(delayCalls()).toHaveLength(0);
});

it('当前节点未测时可单独测速，失败有状态，结果共享到节点列表', async () => {
  useApp.setState({ routing: { primary: '常规', managed: ['常规'] } });
  vi.mocked(api.mihomo).mockResolvedValue({ delay: 72 });
  await act(async () => root.render(createElement(OverviewPage, { active: false })));
  const trigger = () => host.querySelector<HTMLButtonElement>('[aria-label^="测速当前节点"]');
  expect(trigger()).not.toBeNull();
  expect(trigger()!.textContent).toContain('未测');
  await act(async () => trigger()!.click());
  expect(delayCalls()).toHaveLength(1);
  expect(trigger()!.textContent).toContain('72');
  expect(useApp.getState().groups[0].nodes[0].delaysByTarget?.['https://www.google.com/generate_204']).toBe(72);
  vi.mocked(api.mihomo).mockRejectedValue(new Error('timeout'));
  await act(async () => trigger()!.click());
  expect(trigger()!.textContent).toContain('失败');
});

it('只在可见且当前节点无记录时补一次测速，隐藏/重开/轮询不重复，也不测备用节点', async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(api.probeService).mockResolvedValue({ ok: true, latency_ms: 12 });
    useApp.setState({ routing: { primary: '常规', managed: ['常规'] }, refreshGroups: vi.fn().mockResolvedValue(true),
      groups: [{ name: '常规', type: 'Selector', now: 'A', nodes: [
        { name: 'A', type: 'Shadowsocks', delay: null }, { name: 'B', type: 'Shadowsocks', delay: null },
      ] }] });
    vi.mocked(api.mihomo).mockImplementation(async (_method, path) => String(path).includes('/delay?') ? { delay: 64 } : { connections: [] });
    await act(async () => root.render(createElement(OverviewPage, { active: false })));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(delayCalls()).toHaveLength(0);
    await act(async () => root.render(createElement(OverviewPage, { active: true })));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(delayCalls()).toHaveLength(1);
    expect(String(delayCalls()[0][1])).toContain('/proxies/A/delay?');
    expect(host.querySelector('.hero-gauge')?.textContent).toContain('64');
    await act(async () => root.render(createElement(OverviewPage, { active: false })));
    await act(async () => vi.advanceTimersByTimeAsync(600_000));
    await act(async () => root.render(createElement(OverviewPage, { active: true })));
    await act(async () => vi.advanceTimersByTimeAsync(600_000));
    expect(delayCalls()).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});

it('testDelay 显式传目标，旧调用维持通用目标，失败不返回历史值', async () => {
  vi.mocked(api.mihomo).mockImplementation(async (_method, path) => String(path).includes('/delay?') ? { delay: 42 } : reportedGithub(42));
  expect(await useApp.getState().testDelay('A', GITHUB_LATENCY_URL)).toBe(42);
  expect(new URL(String(vi.mocked(api.mihomo).mock.calls[0][1]), 'http://mock.test').searchParams.get('url')).toBe(GITHUB_LATENCY_URL);
  expect(new URL(String(vi.mocked(api.mihomo).mock.calls[0][1]), 'http://mock.test').searchParams.get('expected')).toBe('200');
  await useApp.getState().testDelay('A');
  expect(vi.mocked(api.mihomo).mock.calls[1]).toEqual(['GET', '/proxies/A']);
  expect(new URL(String(delayCalls()[1][1]), 'http://mock.test').searchParams.get('url')).toBe(DEFAULT_LATENCY_URL);
  expect(new URL(String(delayCalls()[1][1]), 'http://mock.test').searchParams.get('expected')).toBeNull();
  vi.mocked(api.mihomo).mockRejectedValue(new Error('timeout'));
  expect(await useApp.getState().testDelay('A', GITHUB_LATENCY_URL)).toBeNull();
});

it('服务连通显示当前选中节点，不使用过期的手动节点设置', async () => {
  vi.useFakeTimers();
  try {
    useApp.setState({ refreshGroups: vi.fn().mockResolvedValue(true), settings: { ...initial.settings, mode: 'rule', egressGuard: true, egressGuardNode: 'Old' },
      groups: [{ name: 'GitHub 固定出口', type: 'Selector', now: 'Actual', nodes: [{ name: 'Actual', type: 'Vless', delay: null }] }] });
    vi.mocked(api.probeService).mockImplementation(async id => ({ id, ok: true, latency_ms: 12 }));
    vi.mocked(api.mihomo).mockResolvedValue({ connections: [] });
    await act(async () => root.render(createElement(OverviewPage, { active: true })));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(api.probeService).toHaveBeenCalledWith('github', 'Actual');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-controls="diagnostic-details"]')!.click());
    const githubTile = () => [...host.querySelectorAll<HTMLElement>('.service-tile')].find(tile => tile.textContent?.includes('GitHub'))!;
    expect(host.querySelector('#diagnostic-details .ov-evidence-service-route')?.textContent).toBe('Actual');
    expect(host.querySelector('#diagnostic-details')?.textContent).not.toContain('Old');
    expect(githubTile().title).toBe('测速节点：Actual');
    for (const settings of [
      { ...initial.settings, mode: 'global' as const, egressGuard: true, egressGuardNode: 'Old' },
      { ...initial.settings, mode: 'rule' as const, egressGuard: false, egressGuardNode: 'Old' },
    ]) {
      await act(async () => useApp.setState({ settings }));
      expect(githubTile().textContent).not.toContain('固定出口');
    }
  } finally { vi.useRealTimers(); }
});

it.each([
  ['HTTP 状态失败', { Alive: false, History: [{ delay: 42 }] }],
  ['状态未知', { History: [{ delay: 42 }] }],
  ['最近一次失败', { Alive: true, History: [{ delay: 42 }, { delay: 0 }] }],
  ['没有目标历史', { Alive: true, History: [] }],
] as const)('GitHub 正数 delay 遇到%s时返回失败', async (_case, state) => {
  vi.mocked(api.mihomo).mockResolvedValueOnce({ delay: 42 }).mockResolvedValueOnce({ history: [{ delay: 42 }], extra: { [GITHUB_LATENCY_URL]: state } });
  expect(await useApp.getState().testDelay('A', GITHUB_LATENCY_URL)).toBeNull();
  expect(vi.mocked(api.mihomo).mock.calls[1]).toEqual(['GET', '/proxies/A']);
});

it('GitHub 只采信明确成功的目标历史，兼容小写字段，不回落通用目标', async () => {
  vi.mocked(api.mihomo).mockResolvedValueOnce({ delay: 42 }).mockResolvedValueOnce({ extra: { [DEFAULT_LATENCY_URL]: { Alive: true, History: [{ delay: 42 }] } } });
  expect(await useApp.getState().testDelay('A', GITHUB_LATENCY_URL)).toBeNull();
  vi.mocked(api.mihomo).mockResolvedValueOnce({ delay: 42 }).mockResolvedValueOnce({ extra: { [GITHUB_LATENCY_URL]: { alive: true, history: [{ delay: 31 }] } } });
  expect(await useApp.getState().testDelay('A', GITHUB_LATENCY_URL)).toBe(31);
});

it('内核自动测速的 extra URL 历史按所属分组解析，不读取最新通用 history', async () => {
  useApp.setState({ routing: { primary: '常规', managed: ['常规', '开发'] } });
  vi.mocked(api.mihomo).mockResolvedValue({ proxies: {
    常规: { type: 'Selector', now: 'A', all: ['A'] }, 开发: { type: 'Selector', now: 'A', all: ['A'] },
    A: { type: 'Shadowsocks', history: [{ delay: 999 }], extra: {
      [DEFAULT_LATENCY_URL]: { Alive: true, History: [{ delay: 21 }] },
      [GITHUB_LATENCY_URL]: { Alive: true, History: [{ delay: 82 }] },
    } },
  } });
  expect(await useApp.getState().refreshGroups(false)).toBe(true);
  expect(useApp.getState().groups.find(group => group.name === '常规')!.nodes[0].delay).toBe(21);
  expect(useApp.getState().groups.find(group => group.name === '开发')!.nodes[0].delay).toBe(82);
});

it('节点页在测速按钮标明 GitHub 目标，未测不使用普通历史；两种手动结果和刷新互不污染', async () => {
  vi.mocked(api.mihomo).mockImplementation(respondToLatency);
  await act(async () => root.render(createElement(ProxiesPage)));
  await viewGroup('开发');
  expect(section('开发').querySelector('[aria-label="开发 测速"]')?.getAttribute('title')).toBe('测试 GitHub 目标延迟');
  expect(section('开发').textContent).toContain('未测');
  expect(section('开发').textContent).not.toContain('999 ms');
  await testGroup('开发');
  expect(section('开发').textContent).toContain('82 ms');
  await viewGroup('常规');
  expect(section('常规').textContent).not.toContain('82 ms');
  await testGroup('常规');
  expect(section('常规').textContent).toContain('21 ms');
  await act(async () => useApp.setState({ groups: groups() }));
  await viewGroup('开发');
  expect(section('开发').textContent).toContain('82 ms');
  await viewGroup('常规');
  expect(section('常规').textContent).toContain('21 ms');
  vi.mocked(api.mihomo).mockRejectedValue(new Error('timeout'));
  await testGroup('开发');
  expect(section('开发').textContent).toContain('失败');
  expect(section('开发').textContent).not.toContain('82 ms');
  expect(vi.mocked(api.mihomo).mock.calls.some(([method]) => method === 'PUT')).toBe(false);
});

it('概览当前组使用相同目标，切换分组不会复用另一目标的结果，失败覆盖旧值', async () => {
  useApp.setState({ routing: { primary: '开发', managed: ['开发', '常规'] }, refreshGroups: vi.fn().mockResolvedValue(true) });
  vi.mocked(api.mihomo).mockImplementation(respondToLatency);
  await act(async () => root.render(createElement(OverviewPage, { active: false })));
  const groupCard = () => host.querySelector<HTMLElement>('.group-card')!;
  const clickTest = () => act(async () => host.querySelector<HTMLButtonElement>('[aria-label="测速当前分组"]')!.click());
  expect(groupCard().textContent).toContain('GitHub 延迟');
  expect(groupCard().textContent).toContain('未测');
  await clickTest();
  expect(new URL(String(vi.mocked(api.mihomo).mock.calls[0][1]), 'http://mock.test').searchParams.get('url')).toBe(GITHUB_LATENCY_URL);
  expect(new URL(String(vi.mocked(api.mihomo).mock.calls[0][1]), 'http://mock.test').searchParams.get('expected')).toBe('200');
  expect(groupCard().textContent).toContain('82 ms');
  await act(async () => useApp.setState({ routing: { primary: '常规', managed: ['开发', '常规'] } }));
  expect(groupCard().textContent).not.toContain('82 ms');
  expect(groupCard().textContent).toContain('未测');
  await clickTest();
  expect(new URL(String(delayCalls()[1][1]), 'http://mock.test').searchParams.get('url')).toBe(DEFAULT_LATENCY_URL);
  expect(groupCard().textContent).toContain('21 ms');
  await act(async () => useApp.setState({ routing: { primary: '开发', managed: ['开发', '常规'] } }));
  vi.mocked(api.mihomo).mockRejectedValue(new Error('timeout'));
  await clickTest();
  expect(groupCard().textContent).toContain('失败');
  expect(groupCard().textContent).not.toContain('82 ms');
  expect(vi.mocked(api.mihomo).mock.calls.some(([method]) => method === 'PUT')).toBe(false);
  expect(vi.mocked(api.mihomo).mock.calls.some(([, path]) => String(path).startsWith('/group/'))).toBe(false);
});

it.each(['节点页', '概览'] as const)('%s 在重连后丢弃旧测速回包，并允许再次测速', async page => {
  useApp.setState({ routing: { primary: '开发', managed: ['开发', '常规'] }, refreshGroups: vi.fn().mockResolvedValue(true) });
  let finish!: (value: unknown) => void;
  vi.mocked(api.mihomo).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => root.render(page === '节点页' ? createElement(ProxiesPage) : createElement(OverviewPage, { active: false })));
  if (page === '节点页') await viewGroup('开发');
  const panel = () => page === '节点页' ? section('开发') : host.querySelector<HTMLElement>('.group-card')!;
  const trigger = () => panel().querySelector<HTMLButtonElement>(page === '节点页' ? '.proxy-group-actions button' : '[aria-label="测速当前分组"]')!;
  await act(async () => { trigger().click(); });
  expect(api.mihomo).toHaveBeenCalledTimes(1);
  await act(async () => useApp.setState({ connectedAt: 1000 }));
  await act(async () => finish({ delay: 74 }));
  expect(panel().textContent).toContain('未测');
  expect(panel().textContent).not.toContain('74 ms');
  vi.mocked(api.mihomo).mockImplementation(async (_method, path) => String(path).includes('/delay?') ? { delay: 56 } : reportedGithub(56));
  await act(async () => { trigger().click(); });
  expect(panel().textContent).toContain('56 ms');
});

it.each(['节点页', '概览'] as const)('%s 只测节点，新旧批次最多3个并发，过期排队和详情请求不再发送', async page => {
  const nodeGroup = (prefix: string) => [{ name: '开发', type: 'URLTest', now: `${prefix}A`, nodes: [...'ABCDEFG'].map(letter => ({ name: `${prefix}${letter}`, type: 'Shadowsocks', delay: null })) }];
  useApp.setState({ groups: nodeGroup('旧'), routing: { primary: '开发', managed: ['开发'] }, refreshGroups: vi.fn().mockResolvedValue(true) });
  let inFlight = 0; let peak = 0;
  const pending: Array<() => void> = [];
  vi.mocked(api.mihomo).mockImplementation(async (_method, path) => {
    if (String(path).startsWith('/group/')) throw new Error('分组测速会修改选择，禁止调用');
    inFlight += 1; peak = Math.max(peak, inFlight);
    if (String(path).includes('/delay?')) {
      await new Promise<void>(resolve => pending.push(resolve));
      inFlight -= 1;
      return { delay: 56 };
    }
    inFlight -= 1;
    return reportedGithub(56);
  });
  await act(async () => root.render(page === '节点页' ? createElement(ProxiesPage) : createElement(OverviewPage, { active: false })));
  if (page === '节点页') await viewGroup('开发');
  const panel = () => page === '节点页' ? section('开发') : host.querySelector<HTMLElement>('.group-card')!;
  const trigger = () => panel().querySelector<HTMLButtonElement>(page === '节点页' ? '.proxy-group-actions button' : '[aria-label="测速当前分组"]')!;
  await act(async () => { trigger().click(); trigger().click(); });
  expect(delayCalls()).toHaveLength(3);
  await act(async () => useApp.setState({ connectedAt: 1000, groups: nodeGroup('新') }));
  await act(async () => { trigger().click(); });
  expect(delayCalls()).toHaveLength(3);
  expect(inFlight).toBe(3);
  await act(async () => { pending.splice(0).forEach(finish => finish()); });
  expect(delayCalls()).toHaveLength(6);
  expect(delayCalls().map(([, path]) => decodeURIComponent(String(path).split('/')[2]))).toEqual(['旧A', '旧B', '旧C', '新A', '新B', '新C']);
  expect(vi.mocked(api.mihomo).mock.calls.filter(([, path]) => !String(path).includes('/delay?'))).toHaveLength(0);
  while (pending.length) await act(async () => { pending.splice(0).forEach(finish => finish()); });
  expect(delayCalls()).toHaveLength(10);
  expect(peak).toBe(3);
  expect(inFlight).toBe(0);
  expect(trigger().disabled).toBe(false);
  expect(panel().textContent).toContain('56 ms');
  expect(vi.mocked(api.mihomo).mock.calls.every(([method, path]) => method === 'GET' && String(path).startsWith('/proxies/'))).toBe(true);
  expect(useApp.getState().groups[0].now).toBe('新A');
});

it.each(['URLTest', 'Selector'])('Selector中%s子组旗标禁用并提示展开具体节点', async type => {
  const select = vi.fn(async () => true);
  useApp.setState(s => ({ selectNode: select, groups: [...s.groups.map(g => ({ ...g,
    nodes: [...g.nodes, { name: 'Nested', type, delay: 20 }] })), { name: 'Nested', type, now: 'A', nodes: s.groups[0].nodes }] }));
  await act(async () => root.render(createElement(ProxiesPage)));
  const flag = section('常规').querySelector<HTMLButtonElement>('[aria-label="固定使用 Nested"]')!;
  expect(flag.disabled).toBe(true);
  expect(flag.title).toContain('展开对应分组后固定具体节点');
  await act(async () => flag.closest<HTMLElement>('.proxy-node')!.click());
  expect(select).toHaveBeenCalledWith('常规', 'Nested');
});
