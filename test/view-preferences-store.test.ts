// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'ppclash.view-preferences.v1';
const fresh = async () => { vi.resetModules(); return (await import('../src/store/view-preferences')).useViewPreferences; };
beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); });

it('重建应用恢复选择项与各订阅浏览组，搜索内容不写入磁盘', async () => {
  const store = await fresh();
  store.getState().setPreference('proxySort', 'delay');
  store.getState().setPreference('settingsCategory', '下载');
  store.getState().rememberProxyGroup('a', '工作组');
  store.getState().rememberProxyGroup('b', '影音组');
  store.getState().setQuery('proxies-a', 'private search');
  const restarted = await fresh();
  expect(restarted.getState().preferences.proxySort).toBe('delay');
  expect(restarted.getState().preferences.settingsCategory).toBe('下载');
  expect(restarted.getState().proxyGroups).toEqual([{ profileId: 'a', group: '工作组' }, { profileId: 'b', group: '影音组' }]);
  expect(restarted.getState().queries).toEqual([]);
  expect(localStorage.getItem(STORAGE_KEY)).not.toContain('private search');
});

it('忽略非法选择与多余字段，合法偏好仍可恢复', async () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ preferences: {
    proxySort: 'invalid', proxyAvailableOnly: 'false', resourceTab: 'rules', settingsCategory: '已移除分类',
    selectNode: 'unexpected action', password: 'secret',
  }, proxyGroups: [null, { profileId: 3, group: true }, { profileId: 'a', group: '工作组' }] }));
  const store = await fresh();
  expect(store.getState().preferences).toMatchObject({ proxySort: 'default', proxyAvailableOnly: false, resourceTab: 'rules', settingsCategory: '外观' });
  expect(store.getState().preferences).not.toHaveProperty('password');
  expect(store.getState().proxyGroups).toEqual([{ profileId: 'a', group: '工作组' }]);
  store.getState().setPreference('resourceTab', 'proxies');
  expect(localStorage.getItem(STORAGE_KEY)).not.toContain('secret');
});

it('损坏或不可写的存储不阻止切换，当前进程仍有记忆', async () => {
  localStorage.setItem(STORAGE_KEY, '{broken');
  const store = await fresh();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('storage denied'); });
  expect(() => store.getState().setPreference('resourceTab', 'rules')).not.toThrow();
  expect(store.getState().preferences.resourceTab).toBe('rules');
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw Error('storage denied'); });
  expect((await fresh()).getState().preferences.proxySort).toBe('default');
});

it('长期切换订阅和搜索不会无限积累记录，重复订阅只保留最近选择', async () => {
  const store = await fresh();
  for (let i = 0; i < 80; i++) {
    store.getState().rememberProxyGroup(`p-${i}`, `g-${i}`);
    store.getState().setQuery(`q-${i}`, `query-${i}`);
  }
  store.getState().rememberProxyGroup('p-40', '已更换');
  expect(store.getState().proxyGroups).toHaveLength(64);
  expect(store.getState().queries).toHaveLength(64);
  expect(store.getState().proxyGroups.some(item => item.profileId === 'p-0')).toBe(false);
  expect(store.getState().proxyGroups.filter(item => item.profileId === 'p-40')).toEqual([{ profileId: 'p-40', group: '已更换' }]);
});
