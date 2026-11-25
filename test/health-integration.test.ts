// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../src/core/api';
import { useApp, getRoutingRevision } from '../src/store/app';
import { startBackgroundHealth } from '../src/application/background-health';
import { CHECK_INTERVAL } from '../src/core/failover';

vi.mock('../src/core/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/api')>();
  return { ...actual, isTauri: true, api: Object.fromEntries(Object.keys(actual.api).map(k => [k, vi.fn().mockResolvedValue(undefined)])) };
});
let stop: (() => void) | undefined;
let selected: string;
const failed = { google: false, github: false, openai: true };
const healthy = { google: true, github: true, openai: true };
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000); localStorage.clear(); selected = 'A';
  useApp.setState({ ...useApp.getInitialState(), kernelPhase: 'running', tunEnabled: true, connectedAt: 1,
    routing: { primary: 'Main', managed: ['Main'] },
    settings: { ...useApp.getInitialState().settings, autoFailover: true, egressGuard: false } });
  vi.mocked(api.mihomo).mockImplementation(async (method, path, body) => {
    if (method === 'PUT') { selected = (body as { name: string }).name; return {}; }
    if (path === '/proxies') return { proxies: { Main: { type: 'Selector', now: selected, all: ['A', 'B', 'C'] }, A: { type: 'Shadowsocks' }, B: { type: 'Shadowsocks' }, C: { type: 'Shadowsocks' } } };
    if (path === '/rules') return { rules: [{ type: 'Match', proxy: 'Main' }] };
    throw new Error(`unexpected ${method} ${path}`);
  });
  vi.mocked(api.probeNodeHealth).mockImplementation(async node => node === 'A' ? failed : healthy);
  await useApp.getState().refreshGroups();
});
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); vi.clearAllMocks(); });
const rounds = async (count: number) => { await vi.advanceTimersByTimeAsync(count * CHECK_INTERVAL); };
const puts = () => vi.mocked(api.mihomo).mock.calls.filter(([method]) => method === 'PUT');

it('后台三轮故障验证备用后只切换一次，冷却能跨控制层重建保留', async () => {
  stop = startBackgroundHealth();
  expect(api.probeNodeHealth).not.toHaveBeenCalled();
  await rounds(2); expect(puts()).toHaveLength(0);
  await rounds(1); expect(puts()).toHaveLength(1); expect(selected).toBe('B');
  expect(api.probeNodeHealth).toHaveBeenCalledTimes(4);
  stop(); stop = startBackgroundHealth();
  await rounds(4); expect(puts()).toHaveLength(1); expect(api.probeNodeHealth).toHaveBeenCalledTimes(4);
});

it('控制器读取失败清空失败计数，绝不利用旧分组切换', async () => {
  stop = startBackgroundHealth(); await rounds(2);
  vi.mocked(api.mihomo).mockRejectedValueOnce(new Error('controller offline'));
  await rounds(1); await rounds(2); expect(puts()).toHaveLength(0);
  await rounds(1); expect(puts()).toHaveLength(1);
});

it('关闭后立即重新启用也不会沿用旧失败轮次', async () => {
  stop = startBackgroundHealth(); await rounds(2);
  useApp.getState().updateSettings({ autoFailover: false });
  useApp.getState().updateSettings({ autoFailover: true });
  await rounds(2); expect(puts()).toHaveLength(0);
  await rounds(1); expect(puts()).toHaveLength(1);
});

it('睡眠恢复跳过当前轮，重新等待网络稳定再累计', async () => {
  stop = startBackgroundHealth(); await rounds(2);
  vi.setSystemTime(Date.now() + 3_600_000);
  await rounds(1); expect(api.probeNodeHealth).toHaveBeenCalledTimes(2);
  await rounds(2); expect(puts()).toHaveLength(0);
  await rounds(1); expect(puts()).toHaveLength(1);
});

it.each([60_000, 3_600_000, -60_000])('读取分组期间时钟跳变 %i ms，迟到结果不能触发探测或沿用旧失败切换', async jump => {
  stop = startBackgroundHealth(); await rounds(2);
  const read = vi.mocked(api.mihomo).getMockImplementation()!;
  let finish!: () => void;
  vi.mocked(api.mihomo).mockImplementationOnce((method, path, body) =>
    new Promise(resolve => { finish = () => resolve(read(method, path, body)); }));
  await rounds(1);
  expect(api.probeNodeHealth).toHaveBeenCalledTimes(2);
  vi.setSystemTime(Date.now() + jump);
  finish(); await vi.advanceTimersByTimeAsync(0);
  expect(puts()).toHaveLength(0);
  expect(api.probeNodeHealth).toHaveBeenCalledTimes(2);
  await rounds(2); expect(puts()).toHaveLength(0);
  await rounds(1); expect(puts()).toHaveLength(1);
});

it('自动切换排队期间休眠，执行前丢弃过期候选且不进入切换冷却', async () => {
  let finish!: () => void;
  vi.mocked(api.mihomo).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({}); }));
  const manual = useApp.getState().selectNode('Main', 'A');
  await vi.advanceTimersByTimeAsync(0);
  expect(puts()).toEqual([['PUT', '/proxies/Main', { name: 'A' }]]);
  stop = startBackgroundHealth(); await rounds(3);
  expect(api.probeNodeHealth).toHaveBeenCalledWith('B');
  vi.setSystemTime(Date.now() + 60_000);
  finish(); await manual; await vi.advanceTimersByTimeAsync(0);
  expect(selected).toBe('A');
  expect(puts()).toHaveLength(1);
  expect(localStorage.getItem('ppclash.failoverCooldown')).toBeNull();
  await rounds(2); expect(puts()).toHaveLength(1);
  await rounds(1); expect(selected).toBe('B'); expect(puts()).toHaveLength(2);
});

it('前一分组探测跨越休眠，本轮不能继续探测后续分组或触发切换', async () => {
  const read = vi.mocked(api.mihomo).getMockImplementation()!;
  vi.mocked(api.mihomo).mockImplementation(async (method, path, body) => {
    const result = await read(method, path, body);
    if (method === 'GET' && path === '/proxies') result.proxies.Second = { ...result.proxies.Main };
    return result;
  });
  useApp.setState({ routing: { primary: 'Main', managed: ['Main', 'Second'], roots: ['Main', 'Second'] } });
  stop = startBackgroundHealth(); await rounds(2);
  expect(api.probeNodeHealth).toHaveBeenCalledTimes(4);
  let finish!: (value: typeof failed) => void;
  vi.mocked(api.probeNodeHealth).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await rounds(1);
  vi.setSystemTime(Date.now() + 60_000);
  finish(failed); await vi.advanceTimersByTimeAsync(0);
  expect(puts()).toHaveLength(0);
  expect(api.probeNodeHealth).toHaveBeenCalledTimes(5);
  await rounds(2); expect(puts()).toHaveLength(0);
  await rounds(1); expect(puts()).toHaveLength(1);
});

it('分组读取和探测合计过期，不能分别续期后自动切换', async () => {
  stop = startBackgroundHealth(); await rounds(2);
  const read = vi.mocked(api.mihomo).getMockImplementation()!;
  let finishRead!: () => void;
  let finishProbe!: (value: typeof failed) => void;
  vi.mocked(api.mihomo).mockImplementationOnce((method, path, body) =>
    new Promise(resolve => { finishRead = () => resolve(read(method, path, body)); }));
  vi.mocked(api.probeNodeHealth).mockImplementationOnce(() => new Promise(resolve => { finishProbe = resolve; }));
  await rounds(1);
  vi.setSystemTime(Date.now() + 30_000);
  finishRead(); await vi.advanceTimersByTimeAsync(0);
  expect(api.probeNodeHealth).toHaveBeenCalledTimes(3);
  vi.setSystemTime(Date.now() + 20_000);
  finishProbe(failed); await vi.advanceTimersByTimeAsync(0);
  expect(puts()).toHaveLength(0);
  expect(api.probeNodeHealth).toHaveBeenCalledTimes(3);
});

it('丢弃迟到结果后等待完整稳定间隔，期间不补发或重叠探测', async () => {
  stop = startBackgroundHealth(); await rounds(2);
  const read = vi.mocked(api.mihomo).getMockImplementation()!;
  let finish!: () => void;
  vi.mocked(api.mihomo).mockImplementationOnce((method, path, body) =>
    new Promise(resolve => { finish = () => resolve(read(method, path, body)); }));
  await rounds(1);
  await vi.advanceTimersByTimeAsync(180_000);
  finish(); await vi.advanceTimersByTimeAsync(0);
  expect(api.probeNodeHealth).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(119_999);
  expect(api.probeNodeHealth).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(api.probeNodeHealth).toHaveBeenCalledTimes(3);
  expect(puts()).toHaveLength(0);
});

it('停止控制层后迟到结果不探测、不切换，也不重新调度', async () => {
  stop = startBackgroundHealth(); await rounds(2);
  const read = vi.mocked(api.mihomo).getMockImplementation()!;
  let finish!: () => void;
  vi.mocked(api.mihomo).mockImplementationOnce((method, path, body) =>
    new Promise(resolve => { finish = () => resolve(read(method, path, body)); }));
  await rounds(1);
  stop(); stop = undefined;
  vi.setSystemTime(Date.now() + 60_000);
  finish(); await vi.advanceTimersByTimeAsync(0);
  const reads = vi.mocked(api.mihomo).mock.calls.length;
  await rounds(10);
  expect(api.mihomo).toHaveBeenCalledTimes(reads);
  expect(api.probeNodeHealth).toHaveBeenCalledTimes(2);
  expect(puts()).toHaveLength(0);
});

it('多个分组正常慢探测不会让末尾出口饿死或清空连续失败', async () => {
  const names = Array.from({ length: 8 }, (_, i) => `Group${i}`);
  const selections = Object.fromEntries(names.map((name, i) => [name, `A${i}`]));
  useApp.setState({ routing: { primary: names[0], managed: names, roots: names } });
  vi.mocked(api.mihomo).mockImplementation(async (method, path, body) => {
    if (method === 'PUT') { selections[path.slice('/proxies/'.length)] = (body as { name: string }).name; return {}; }
    if (path !== '/proxies') throw new Error(`unexpected ${method} ${path}`);
    return { proxies: Object.fromEntries([
      ...names.map((name, i) => [name, { type: 'Selector', now: selections[name], all: [`A${i}`, 'B'] }]),
      ...[...names.map((_, i) => `A${i}`), 'B'].map(name => [name, { type: 'Shadowsocks' }]),
    ]) };
  });
  vi.mocked(api.probeNodeHealth).mockImplementation(async node => {
    vi.setSystemTime(Date.now() + 7000);
    return node === 'A7' ? failed : healthy;
  });
  stop = startBackgroundHealth();
  await rounds(1);
  expect(api.probeNodeHealth).toHaveBeenCalledWith('A7');
  await rounds(1); expect(puts()).toHaveLength(0);
  await rounds(1);
  expect(puts()).toEqual([['PUT', '/proxies/Group7', { name: 'B' }]]);
  expect(selections.Group7).toBe('B');
});

it.each([5, 16])('后组共享当前坏节点且有 %i 个中间组时，正常慢探测仍能累计故障切换', async count => {
  const names = ['First', ...Array.from({ length: count }, (_, i) => `Middle${i}`), 'Last'];
  const nodes = ['A', ...Array.from({ length: count }, (_, i) => `N${i}`), 'A'];
  const selections = Object.fromEntries(names.map((name, i) => [name, nodes[i]]));
  useApp.setState({ routing: { primary: names[0], managed: names, roots: names } });
  vi.mocked(api.mihomo).mockImplementation(async (method, path, body) => {
    if (method === 'PUT') { selections[path.slice('/proxies/'.length)] = (body as { name: string }).name; return {}; }
    if (path !== '/proxies') throw new Error(`unexpected ${method} ${path}`);
    return { proxies: Object.fromEntries([
      ...names.map(name => [name, { type: 'Selector', now: selections[name], all: name === 'Last' ? ['A', 'B'] : [selections[name]] }]),
      ...[...nodes, 'B'].map(name => [name, { type: 'Shadowsocks' }]),
    ]) };
  });
  vi.mocked(api.probeNodeHealth).mockImplementation(async node => {
    vi.setSystemTime(Date.now() + 7000);
    return node === 'A' ? failed : healthy;
  });
  stop = startBackgroundHealth(); await rounds(3);
  expect(puts()).toEqual([['PUT', '/proxies/Last', { name: 'B' }]]);
  expect(selections.Last).toBe('B');
});

it('后续分组独立检测共享节点，不复用先前结果', async () => {
  const names = Array.from({ length: 8 }, (_, i) => `Group${i}`);
  const nodes = ['A', 'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'A'];
  useApp.setState({ routing: { primary: names[0], managed: names, roots: names } });
  vi.mocked(api.mihomo).mockImplementation(async () => ({ proxies: Object.fromEntries([
    ...names.map((name, i) => [name, { type: 'Selector', now: nodes[i], all: [nodes[i], 'B'] }]),
    ...[...nodes, 'B'].map(name => [name, { type: 'Shadowsocks' }]),
  ]) }));
  vi.mocked(api.probeNodeHealth).mockImplementation(async () => {
    vi.setSystemTime(Date.now() + 7000);
    return healthy;
  });
  stop = startBackgroundHealth(); await rounds(1);
  expect(vi.mocked(api.probeNodeHealth).mock.calls.filter(([node]) => node === 'A')).toHaveLength(2);
  expect(puts()).toHaveLength(0);
});

it('后组重新验证共享候选，旧组结果过期不妨碍本组有效排队执行', async () => {
  const names = ['First', 'Middle1', 'Middle2', 'Middle3', 'Middle4', 'Last'];
  const nodes = ['B', 'N1', 'N2', 'N3', 'N4', 'A'];
  const selections = Object.fromEntries(names.map((name, i) => [name, nodes[i]]));
  useApp.setState({ routing: { primary: names[0], managed: names, roots: names } });
  vi.mocked(api.mihomo).mockImplementation(async (method, path, body) => {
    if (method === 'PUT') { selections[path.slice('/proxies/'.length)] = (body as { name: string }).name; return {}; }
    if (path !== '/proxies') throw new Error(`unexpected ${method} ${path}`);
    return { proxies: Object.fromEntries([
      ...names.map(name => [name, { type: 'Selector', now: selections[name], all: [selections[name], 'B'] }]),
      ...nodes.map(name => [name, { type: 'Shadowsocks' }]),
    ]) };
  });
  await useApp.getState().refreshGroups();
  let finish!: () => void;
  vi.mocked(api.mihomo).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({}); }));
  const manual = useApp.getState().selectNode('Last', 'A');
  await vi.advanceTimersByTimeAsync(0);
  vi.mocked(api.probeNodeHealth).mockImplementation(async node => {
    vi.setSystemTime(Date.now() + (node === 'B' ? 2000 : node === 'A' ? 0 : 7000));
    return node === 'A' ? failed : healthy;
  });
  stop = startBackgroundHealth(); await rounds(3);
  expect(vi.mocked(api.probeNodeHealth).mock.calls.filter(([node]) => node === 'B')).toHaveLength(4);
  vi.setSystemTime(Date.now() + 20_000);
  finish(); await manual; await vi.advanceTimersByTimeAsync(0);
  expect(puts()).toEqual([['PUT', '/proxies/Last', { name: 'A' }], ['PUT', '/proxies/Last', { name: 'B' }]]);
  expect(selections.Last).toBe('B');
  expect(Number(localStorage.getItem('ppclash.failoverCooldown'))).toBeGreaterThan(Date.now());
});

it('候选检测期间手动选择其他节点，旧结果不能反向覆盖', async () => {
  let finish!: (value: typeof healthy) => void;
  vi.mocked(api.probeNodeHealth).mockImplementation(node => node === 'A' ? Promise.resolve(failed) : new Promise(r => { finish = r; }));
  stop = startBackgroundHealth(); await rounds(3);
  await useApp.getState().selectNode('Main', 'C');
  finish(healthy); await vi.advanceTimersByTimeAsync(0);
  expect(selected).toBe('C'); expect(puts()).toHaveLength(1);
});

it('排队的自动选择遇到用户新操作时取消，并保留最后手动选择', async () => {
  const revision = getRoutingRevision();
  const automatic = useApp.getState().selectNode('Main', 'B', revision);
  const manual = useApp.getState().selectNode('Main', 'C');
  expect(await automatic).toBe(false); expect(await manual).toBe(true);
  expect(selected).toBe('C'); expect(puts()).toHaveLength(1);
});

it('刷新仅更新读到的分组，不写配置或重启；接管现有内核使用实际 MATCH', async () => {
  useApp.setState({ routing: null });
  expect(await useApp.getState().refreshGroups()).toBe(true);
  expect(useApp.getState().routing?.primary).toBe('Main');
  expect(api.saveConfig).not.toHaveBeenCalled(); expect(api.stopKernel).not.toHaveBeenCalled();
  expect(api.startKernel).not.toHaveBeenCalled(); expect(puts()).toHaveLength(0);
});

it('重启在停机之前准备并校验配置，停机后不再次生成', async () => {
  const generated = vi.fn(useApp.getState().applyConfig);
  useApp.setState({ applyConfig: generated, activeId: 'synthetic',
    profiles: [{ id: 'synthetic', name: 'fixture', url: '', raw: 'proxies: []\nproxy-groups: []\nrules: []', updatedAt: 0, userinfo: null, updateIntervalHours: null }] });
  vi.mocked(api.prepareConfig).mockResolvedValue('/isolated/candidate.yaml');
  vi.mocked(api.commitConfig).mockResolvedValue('/isolated/validated.yaml');
  vi.mocked(api.startKernel).mockResolvedValue({ running: true, pid: 123 });
  const pending = useApp.getState().restartKernel(true);
  await vi.advanceTimersByTimeAsync(500);
  expect(await pending).toBe(true);
  expect(generated).toHaveBeenCalledTimes(1);
  expect(api.validateConfig).toHaveBeenCalledTimes(1);
  expect(api.startKernel).toHaveBeenCalledWith('/isolated/validated.yaml', '/isolated', null, true, 9090, '');
  expect(vi.mocked(api.validateConfig).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.stopKernel).mock.invocationCallOrder[0]);
});

it('准备配置失败保持原内核，保存出口策略不会隐式重启', async () => {
  useApp.setState({ applyConfig: vi.fn(async () => false) });
  expect(await useApp.getState().restartKernel(true)).toBe(false);
  expect(api.stopKernel).not.toHaveBeenCalled();
  useApp.getState().updateSettings({ stableRouting: false });
  expect(useApp.getState().configPath).toBe('');
  expect(api.startKernel).not.toHaveBeenCalled();
});

it('固定节点连续故障后验证备用并转移固定，原节点恢复不自动跳回', async () => {
  useApp.setState({ activeId: 'fixed-profile', fixedNodes: { 'fixed-profile': { Main: 'A' } } });
  stop = startBackgroundHealth();
  await rounds(2); expect(puts()).toHaveLength(0);
  await rounds(1); expect(selected).toBe('B');
  expect(useApp.getState().fixedNodes['fixed-profile'].Main).toBe('B');
  vi.mocked(api.probeNodeHealth).mockResolvedValue(healthy);
  await rounds(30);
  expect(selected).toBe('B'); expect(puts()).toHaveLength(1);
  expect(useApp.getState().fixedNodes['fixed-profile'].Main).toBe('B');
});
