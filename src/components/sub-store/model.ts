import { resolveDomainError } from './resolver-model';

export type Kind = 'sub' | 'collection' | 'file';
export type Tab = Kind | 'artifact' | 'share' | 'archive';
export type Data = Record<string, unknown>;
export type Entry = Data & { name: string; process?: Processor[] };
export type Processor = Data & { type: string; args?: unknown; disabled?: boolean };
export const TITLES: Record<Tab, string> = { sub: '来源', collection: '组合', file: '文件', artifact: '同步', share: '分享', archive: '归档' };
export const LIST_PATH: Record<Tab, string> = { sub: '/api/subs', collection: '/api/collections', file: '/api/files', artifact: '/api/artifacts', share: '/api/tokens', archive: '/api/archives' };
export const itemPath = (kind: Tab, name: string) => `/api/${kind === 'share' ? 'token' : kind === 'archive' ? 'archives' : kind}/${encodeURIComponent(name)}`;
export const entryIdentity = (kind: Tab, entry: Entry) => kind === 'share' ? JSON.stringify([entry.type, entry.name, entry.token]) : String(entry.id ?? entry.name);
export function localDateTime(value: unknown): string {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return '';
  const date = new Date(time);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (number: number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function normalizeDurationValue(value: unknown): string {
  if (value == null || value === '') return '';
  const number = Number(value);
  return Number.isFinite(number) ? String(Number(number.toFixed(2))) : String(value);
}
export function object(value: unknown): Data { return value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {}; }
export function entries(value: unknown): Entry[] {
  const data = Array.isArray(value) ? value : Object.values(object(value));
  return data.filter(item => item && typeof item === 'object').map(item => {
    const value = object(item);
    return { ...value, name: String(value.name ?? value.token ?? value.id ?? '') } as Entry;
  }).filter(item => item.name);
}
export function parseObject(text: string): Data {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('高级参数必须是 JSON 对象');
  return value as Data;
}
export const pretty = (value: unknown) => JSON.stringify(value, null, 2);
export function createEntry(kind: Tab): Entry {
  if (kind === 'collection') return { name: '', subscriptions: [], process: [] };
  if (kind === 'sub' || kind === 'file') return { name: '', source: 'remote', url: '', content: '', process: [] };
  if (kind === 'artifact') return { name: '', type: 'subscription', source: '', platform: 'ClashMeta', sync: false, upload: false };
  return { name: '', type: 'sub', token: '', mode: 'duration', expiresValue: '7', expiresUnit: 'day' };
}
export const isMihomoFile = (entry: Entry) => entry.type === 'mihomoConfig' || entry.type === 'mihomoProfile';
export function mihomoFileSourceLabel(entry: Entry): string {
  const source = ['subscription', 'collection', 'local', 'remote', 'none'].includes(String(entry.sourceType)) ? entry.sourceType : 'collection';
  if (source === 'none') return '空配置';
  if (source === 'local' || source === 'remote') return `${source === 'local' ? '本地' : '远程'}${entry.mode === 'proxy' ? '节点' : '配置'}`;
  return `${source === 'subscription' ? '来源' : '组合'} · ${String(entry.sourceName || '未选择')}`;
}
export function validateEntry(kind: Tab, entry: Entry, references?: { sources: Entry[]; collections: Entry[] }) {
  if (typeof entry.name !== 'string' || !entry.name.trim()) throw new Error('请输入名称');
  if (kind === 'sub' || kind === 'file') {
    const mihomoFile = kind === 'file' && isMihomoFile(entry);
    const source = mihomoFile ? ['collection', 'subscription', 'remote', 'local', 'none'].includes(String(entry.sourceType)) ? entry.sourceType : 'collection' : entry.source;
    if (source === 'remote' && !String(entry.url ?? '').trim()) throw new Error('请输入远程链接');
    if (source === 'local' && !String(entry.content ?? '').trim()) throw new Error('请输入本地内容');
    if (mihomoFile && (source === 'collection' || source === 'subscription') && !String(entry.sourceName ?? '').trim()) throw new Error('请输入来源名称');
    if (mihomoFile && references && (source === 'collection' || source === 'subscription') && !(source === 'collection' ? references.collections : references.sources).some(item => item.name === entry.sourceName)) throw new Error(`引用的${source === 'collection' ? '组合' : '来源'} ${String(entry.sourceName)} 已不存在，请重新选择`);
  }
  if (kind === 'collection' && (!Array.isArray(entry.subscriptions) || !entry.subscriptions.length)) throw new Error('请选择至少一个来源');
  if (kind === 'artifact' && !String(entry.source ?? '').trim()) throw new Error('请选择同步来源');
  if (kind === 'share') {
    if (entry.mode === 'count' && (!Number.isSafeInteger(Number(entry.count)) || Number(entry.count) <= 0)) throw new Error('访问次数必须是正整数');
    if (entry.mode === 'datetime' && (!Number.isFinite(Number(entry.exp)) || Number(entry.exp) <= Date.now())) throw new Error('到期时间必须晚于当前时间');
    if (entry.mode !== 'count' && entry.mode !== 'datetime' && entry.expiresUnit !== 'lifetime') {
      const duration = Number(normalizeDurationValue(entry.expiresValue));
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('请输入有效时长');
    }
  }
  if (entry.process && (!Array.isArray(entry.process) || entry.process.some(item => !item || typeof item !== 'object' || typeof item.type !== 'string'))) throw new Error('处理器必须包含 type');
  if (Array.isArray(entry.process)) for (const [index, processor] of entry.process.entries()) {
    if (processor.type === 'Resolve Domain Operator' && !processor.disabled) {
      const error = resolveDomainError(processor.args);
      if (error) throw new Error(`处理器 ${index + 1}：${error}`);
    }
  }
}
export function moveProcessor(process: Processor[], index: number, delta: number): Processor[] {
  const target = index + delta;
  if (target < 0 || target >= process.length) return process;
  const next = [...process]; [next[index], next[target]] = [next[target], next[index]]; return next;
}
export function shareRequest(entry: Entry): Data {
  const { token, type, name, mode, expiresIn, expiresValue, expiresUnit, exp, count, usedCount, ...metadata } = entry;
  const units: Record<string, number> = { day: 86400, month: 2592000, season: 7776000, year: 31536000 };
  const timed = mode !== 'count' && mode !== 'datetime' && expiresUnit !== 'lifetime';
  const normalizedValue = timed ? normalizeDurationValue(expiresValue) : expiresValue;
  const duration = timed
    ? Number(normalizedValue) > 0 && Number.isFinite(Number(normalizedValue)) && units[String(expiresUnit)] ? `${Math.round(Number(normalizedValue) * units[String(expiresUnit)])}s` : expiresIn : undefined;
  return { payload: { ...metadata, type, name, ...(token ? { token } : {}) }, options: { mode, expiresIn: duration, expiresValue: normalizedValue, expiresUnit, exp, count, usedCount } };
}
export function downloadPath(kind: Kind, name: string, target: string): string {
  const path = kind === 'file' ? `/api/file/${encodeURIComponent(name)}` : `/download/${kind === 'collection' ? 'collection/' : ''}${encodeURIComponent(name)}`;
  return `${path}?${new URLSearchParams({ target })}`;
}

export function fileUsesEntry(file: Entry, kind: Tab, name: string, includeDisabled = false) {
  const wanted = kind === 'sub' ? 'subscription' : kind;
  const sourceType = ['subscription', 'collection', 'local', 'remote', 'none'].includes(String(file.sourceType)) ? file.sourceType : 'collection';
  if (isMihomoFile(file) && file.sourceName === name && sourceType === wanted) return true;
  return Array.isArray(file.process) && file.process.some(processor => {
    if (!processor || (!includeDisabled && processor.disabled) || processor.type !== 'Add Proxies From Subscription Operator') return false;
    const args = object(processor.args);
    return args.sourceName === name && (args.sourceType === undefined ? 'subscription' : args.sourceType) === wanted;
  });
}
