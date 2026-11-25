import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { create } from 'zustand';

export const SETTINGS_CATEGORIES = ['外观', '连接与后台', '下载', '备份与恢复', '诊断与日志', '应用更新', '页面与订阅'] as const;
interface ViewPreferences {
  proxySort: 'default' | 'delay' | 'name';
  proxyAvailableOnly: boolean;
  connectionSort: 'time' | 'down' | 'up';
  connectionView: 'conn' | 'process';
  ruleView: 'custom' | 'subscription' | 'effective';
  resourceTab: 'geo' | 'rules' | 'proxies';
  settingsCategory: typeof SETTINGS_CATEGORIES[number];
  logLevel: 'all' | 'info' | 'warn' | 'error';
  logRaw: boolean;
  overrideId: string;
  subStoreTab: 'sub' | 'collection' | 'file' | 'artifact' | 'share' | 'archive';
}
const defaults: ViewPreferences = {
  proxySort: 'default', proxyAvailableOnly: false, connectionSort: 'time', connectionView: 'conn',
  ruleView: 'custom', resourceTab: 'geo', settingsCategory: '外观', logLevel: 'all', logRaw: false, overrideId: '',
  subStoreTab: 'sub',
};
const choices: Partial<{ [K in keyof ViewPreferences]: readonly ViewPreferences[K][] }> = {
  proxySort: ['default', 'delay', 'name'], connectionSort: ['time', 'down', 'up'], connectionView: ['conn', 'process'],
  ruleView: ['custom', 'subscription', 'effective'], resourceTab: ['geo', 'rules', 'proxies'],
  settingsCategory: SETTINGS_CATEGORIES, logLevel: ['all', 'info', 'warn', 'error'],
  subStoreTab: ['sub', 'collection', 'file', 'artifact', 'share', 'archive'],
};
interface GroupPreference { profileId: string | null; group: string }
interface SavedPreferences { preferences: ViewPreferences; proxyGroups: GroupPreference[] }
interface ViewStore extends SavedPreferences {
  queries: Array<{ key: string; value: string }>;
  setPreference: <K extends keyof ViewPreferences>(key: K, value: SetStateAction<ViewPreferences[K]>) => void;
  rememberProxyGroup: (profileId: string | null, group: string) => void;
  setQuery: (key: string, value: string) => void;
}
const STORAGE_KEY = 'ppclash.view-preferences.v1';
const RECORD_LIMIT = 64;
const shortString = (value: unknown): value is string => typeof value === 'string' && value.length <= 512;

function readPreferences(): SavedPreferences {
  const result: SavedPreferences = { preferences: { ...defaults }, proxyGroups: [] };
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text || text.length > 100_000) return result;
    const stored = JSON.parse(text);
    for (const key of Object.keys(defaults) as Array<keyof ViewPreferences>) {
      const value: unknown = stored?.preferences?.[key];
      const allowed: readonly unknown[] | undefined = choices[key];
      if (allowed ? allowed.includes(value) : typeof defaults[key] === 'boolean' ? typeof value === 'boolean' : shortString(value)) {
        Object.assign(result.preferences, { [key]: value });
      }
    }
    if (Array.isArray(stored?.proxyGroups)) {
      for (const item of stored.proxyGroups) {
        if (!item || (item.profileId !== null && !shortString(item.profileId)) || !shortString(item.group) || !item.group) continue;
        result.proxyGroups = [...result.proxyGroups.filter(group => group.profileId !== item.profileId),
          { profileId: item.profileId, group: item.group }].slice(-RECORD_LIMIT);
      }
    }
  } catch { /* 存储不可用或损坏时使用默认视图，不影响应用启动。 */ }
  return result;
}

function savePreferences({ preferences, proxyGroups }: SavedPreferences) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ preferences, proxyGroups })); }
  catch { /* 当前进程仍保留选择。 */ }
}

/** 仅保存浏览偏好；运行配置、确认弹窗、执行锁和敏感表单不进入这里。 */
export const useViewPreferences = create<ViewStore>((set, get) => ({
  ...readPreferences(), queries: [],
  setPreference: (key, action) => {
    const before = get().preferences[key];
    const value = typeof action === 'function' ? action(before) : action;
    if (value === before) return;
    set(state => ({ preferences: { ...state.preferences, [key]: value } }));
    savePreferences(get());
  },
  rememberProxyGroup: (profileId, group) => {
    if (!shortString(group) || !group || (profileId !== null && !shortString(profileId))) return;
    set(state => ({ proxyGroups: [...state.proxyGroups.filter(item => item.profileId !== profileId), { profileId, group }].slice(-RECORD_LIMIT) }));
    savePreferences(get());
  },
  setQuery: (key, value) => {
    set(state => ({ queries: [...state.queries.filter(item => item.key !== key),
      ...(value ? [{ key, value }] : [])].slice(-RECORD_LIMIT) }));
  },
}));

export function useViewPreference<K extends keyof ViewPreferences>(key: K): [ViewPreferences[K], Dispatch<SetStateAction<ViewPreferences[K]>>] {
  const value = useViewPreferences(state => state.preferences[key]);
  const change = useCallback((next: SetStateAction<ViewPreferences[K]>) => useViewPreferences.getState().setPreference(key, next), [key]);
  return [value, change];
}

export function useProxyGroupPreference(profileId: string | null): [string | undefined, (group: string) => void] {
  const group = useViewPreferences(state => state.proxyGroups.find(item => item.profileId === profileId)?.group);
  const change = useCallback((next: string) => useViewPreferences.getState().rememberProxyGroup(profileId, next), [profileId]);
  return [group, change];
}

/** 搜索只跨页面保留，退出应用即清空。 */
export function usePageQuery(key: string): [string, (query: string) => void] {
  const value = useViewPreferences(state => state.queries.find(item => item.key === key)?.value ?? '');
  const change = useCallback((query: string) => useViewPreferences.getState().setQuery(key, query), [key]);
  return [value, change];
}
