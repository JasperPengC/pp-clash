import { api } from '../core/api';

interface ProxySnapshot { proxies: Record<string, { type?: string; now?: string; all?: string[] }> }
function readSnapshot(value: unknown): ProxySnapshot {
  if (!value || typeof value !== 'object' || !('proxies' in value) || !value.proxies
    || typeof value.proxies !== 'object' || Array.isArray(value.proxies)) throw new Error('内核返回的节点列表无效');
  return value as ProxySnapshot;
}

/** 动态来源无法在生成阶段确认成员；热加载后只恢复仍存在的手动选择。 */
export async function restoreProxySelections(
  observed: unknown, selections: Record<string, string>, base: string, secret: string, current: () => boolean,
): Promise<unknown> {
  if (!Object.keys(selections).length || !current()) return observed;
  let snapshot = readSnapshot(observed);
  const pending = Object.entries(selections).filter(([group, node]) => {
    const proxy = snapshot.proxies[group];
    return proxy?.type === 'Selector' && Array.isArray(proxy.all) && proxy.all.includes(node) && proxy.now !== node;
  });
  for (const [group, node] of pending) {
    if (!current()) return observed;
    await api.mihomo('PUT', `/proxies/${encodeURIComponent(group)}`, { name: node }, base, secret);
  }
  if (pending.length && current()) {
    observed = await api.mihomo('GET', '/proxies', undefined, base, secret);
    if (!current()) return observed;
    snapshot = readSnapshot(observed);
    for (const [group, node] of pending) {
      if (snapshot.proxies[group]?.type !== 'Selector' || snapshot.proxies[group]?.now !== node
        || !snapshot.proxies[group]?.all?.includes(node)) throw new Error(`内核未确认原节点「${group} / ${node}」`);
    }
  }
  return observed;
}
