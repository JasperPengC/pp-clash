// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest';
import { api } from '../src/core/api';
import { useApp } from '../src/store/app';

vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, isTauri: true, api: Object.fromEntries(Object.keys(actual.api).map(key => [key, vi.fn().mockResolvedValue(undefined)])) };
});

const raw = JSON.stringify({ proxies: [{ name: 'fixture', type: 'socks5', server: 'fixture.invalid', port: 1080 }],
  'proxy-groups': [{ name: 'Main', type: 'select', proxies: ['fixture'] }], rules: ['MATCH,Main'] });

beforeEach(() => {
  vi.resetAllMocks();
  const initial = useApp.getInitialState();
  useApp.setState({ ...initial, profiles: [], activeId: null, notify: vi.fn(), persistenceSession: 'fixture-session',
    settings: { ...initial.settings, egressGuard: false } });
  vi.mocked(api.prepareConfig).mockResolvedValue('/isolated/candidate.yaml');
  vi.mocked(api.validateConfig).mockResolvedValue(undefined);
  vi.mocked(api.discardConfig).mockResolvedValue(undefined);
  vi.mocked(api.saveAppState).mockResolvedValue(undefined);
});

it('加入 Sub-Store 订阅后保存真实来源关联，并只校验候选而不切换当前配置', async () => {
  await useApp.getState().addSubStoreProfile('我的组合', { kind: 'collection', name: 'daily' }, raw);
  const state = useApp.getState();
  expect(state.profiles).toHaveLength(1);
  expect(state.profiles[0]).toMatchObject({ name: '我的组合', raw, sourceType: 'substore', subStore: { kind: 'collection', name: 'daily' } });
  expect(state.activeId).toBeNull();
  expect(api.commitConfig).not.toHaveBeenCalled();
  expect(api.startKernel).not.toHaveBeenCalled();
  expect(api.saveAppState).toHaveBeenCalled();
});

it('无效处理结果或内核校验失败不创建应用订阅', async () => {
  await expect(useApp.getState().addSubStoreProfile('错误', { kind: 'sub', name: 'source' }, 'proxies: []')).rejects.toThrow();
  expect(useApp.getState().profiles).toEqual([]);
  vi.mocked(api.validateConfig).mockRejectedValue(new Error('fixture validation failure'));
  await expect(useApp.getState().addSubStoreProfile('错误', { kind: 'sub', name: 'source' }, raw)).rejects.toThrow(/fixture/);
  expect(useApp.getState().profiles).toEqual([]);
});

it('同一来源重复加入时拒绝创建重复订阅', async () => {
  await useApp.getState().addSubStoreProfile('第一次', { kind: 'sub', name: 'source' }, raw);
  await expect(useApp.getState().addSubStoreProfile('重复', { kind: 'sub', name: 'source' }, raw)).rejects.toThrow(/已添加/);
  expect(useApp.getState().profiles).toHaveLength(1);
});

it('候选校验期间进入恢复状态时不发布新订阅', async () => {
  let release!: () => void;
  vi.mocked(api.validateConfig).mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  const pending = useApp.getState().addSubStoreProfile('并发', { kind: 'sub', name: 'source' }, raw);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  useApp.setState({ persistenceFrozen: true }); release();
  await expect(pending).rejects.toThrow(/状态/);
  expect(useApp.getState().profiles).toEqual([]);
});

it('保存失败不报告 Sub-Store 导入成功，也不留下未持久化关联', async () => {
  vi.mocked(api.saveAppState).mockRejectedValue(new Error('disk unavailable'));
  await expect(useApp.getState().addSubStoreProfile('未保存', { kind: 'sub', name: 'source' }, raw)).rejects.toThrow(/disk/);
  expect(useApp.getState().profiles).toEqual([]);
});

it('来源改名只持久化关联，保留运行raw与更新时间，失败回退原关联', async () => {
  await useApp.getState().addSubStoreProfile('应用名称', { kind: 'collection', name: 'old' }, raw);
  const profile = useApp.getState().profiles[0];
  useApp.setState({ activeId: profile.id });
  await useApp.getState().renameSubStoreReferences({ kind: 'collection', oldName: 'old', newName: 'new' });
  expect(useApp.getState().profiles[0]).toEqual({ ...profile, subStore: { kind: 'collection', name: 'new' } });
  expect(api.startKernel).not.toHaveBeenCalled();
  expect(api.commitConfig).not.toHaveBeenCalled();
  vi.mocked(api.saveAppState).mockRejectedValueOnce(new Error('rename save failed'));
  await expect(useApp.getState().renameSubStoreReferences({ kind: 'collection', oldName: 'new', newName: 'failed' })).rejects.toThrow(/save failed/);
  expect(useApp.getState().profiles[0].subStore?.name).toBe('new');
});
