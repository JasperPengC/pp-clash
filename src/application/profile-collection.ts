import type { Profile, CollectionRecipe } from '../domain/app';
import { processCollection } from '../core/sub-store/client';
import { api } from '../core/api';

export function collectionSources(profiles: Profile[], recipe: CollectionRecipe) {
  if (!Array.isArray(recipe.sources) || recipe.sources.length < 2 || recipe.sources.length > 32
    || new Set(recipe.sources).size !== recipe.sources.length) throw new Error('请选择 2 至 32 个不同的来源订阅');
  return recipe.sources.map(id => {
    const source = profiles.find(p => p.id === id);
    if (!source || source.sourceType === 'collection') throw new Error('来源订阅已移除，请重新选择来源');
    return source;
  });
}

export async function buildCollection(sources: Profile[], recipe: CollectionRecipe, fresh: boolean, port?: number) {
  const contents: string[] = [];
  let chars = 0;
  for (const p of sources) {
    let raw = p.raw;
    if (fresh) {
      if (p.sourceType === 'file' && !p.url) throw new Error('请先为来源订阅关联本机文件');
      try {
        raw = p.sourceType === 'file' ? await api.readSubscriptionFile(p.url)
          : (await api.fetchSubscription(p.url, p.useProxy ? port : undefined)).raw;
      } catch { throw new Error(`无法更新来源「${p.name}」`); }
    }
    chars += raw.length;
    if (chars > 8 * 1024 * 1024) throw new Error('来源订阅内容过大');
    contents.push(raw);
  }
  return processCollection(contents, recipe);
}
