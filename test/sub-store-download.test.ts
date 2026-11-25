import { beforeEach, expect, it, vi } from 'vitest';
import { downloadSubStoreProfile } from '../src/core/sub-store/download';
import { requestSubStore } from '../src/core/sub-store/service';
import { buildCollection } from '../src/application/profile-collection';
import { api } from '../src/core/api';
import { processCollection } from '../src/core/sub-store/client';
import type { Profile } from '../src/domain/app';
vi.mock('../src/core/sub-store/service', () => ({ requestSubStore: vi.fn() }));
vi.mock('../src/core/sub-store/client', () => ({ processCollection: vi.fn() }));
vi.mock('../src/core/api', () => ({ api: { fetchSubscription: vi.fn(), readSubscriptionFile: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());
it('Sub-Store 单条和组合刷新绕过缓存并编码本机代理', async () => {
  vi.mocked(requestSubStore).mockResolvedValue('fresh');
  await downloadSubStoreProfile({ kind: 'sub', name: 'a / 中文' }, 7890);
  expect(requestSubStore).toHaveBeenLastCalledWith('/download/a%20%2F%20%E4%B8%AD%E6%96%87?target=ClashMeta&noCache=true&proxy=http%3A%2F%2F127.0.0.1%3A7890');
  await downloadSubStoreProfile({ kind: 'collection', name: 'combined' });
  expect(requestSubStore).toHaveBeenLastCalledWith('/download/collection/combined?target=ClashMeta&noCache=true');
});
it('旧组合器刷新 Sub-Store 来源通过引擎重新生成，保留源顺序', async () => {
  const source: Profile = { id: 'a', name: '来源', url: '', raw: 'old', updatedAt: 1, userinfo: null, updateIntervalHours: null,
    sourceType: 'substore', subStore: { kind: 'sub', name: 'source' }, useProxy: true };
  const other: Profile = { ...source, id: 'b', sourceType: 'file', url: '/fixture/file', subStore: undefined, useProxy: false };
  vi.mocked(requestSubStore).mockResolvedValue('fresh-engine');
  vi.mocked(api.readSubscriptionFile).mockResolvedValue('fresh-file');
  const recipe = { sources: ['a', 'b'], include: '', exclude: '', find: '', replace: '' };
  await buildCollection([source, other], recipe, true, 7890);
  expect(processCollection).toHaveBeenCalledWith(['fresh-engine', 'fresh-file'], recipe);
  expect(requestSubStore).toHaveBeenCalledWith('/download/source?target=ClashMeta&noCache=true&proxy=http%3A%2F%2F127.0.0.1%3A7890');
  expect(api.fetchSubscription).not.toHaveBeenCalled();
});
