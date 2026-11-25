import type { SubStoreReference } from '../../domain/app';
import { requestSubStore } from './service';

/** 更新请求绕过引擎源缓存，并沿用调用方选择的本机代理。 */
export function downloadSubStoreProfile(reference: SubStoreReference, proxyPort?: number): Promise<string> {
  const query = new URLSearchParams({ target: 'ClashMeta', noCache: 'true' });
  if (proxyPort) query.set('proxy', `http://127.0.0.1:${proxyPort}`);
  return requestSubStore<string>(`/download/${reference.kind === 'collection' ? 'collection/' : ''}${encodeURIComponent(reference.name)}?${query}`);
}
