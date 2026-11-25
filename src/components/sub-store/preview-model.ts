import { object, type Data } from './model';

const metadata = new Set(['id', '_subName', '_subDisplayName', '_collectionName', '_collectionDisplayName']);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(object(value)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
export function changedFields(before: Data, after: Data): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => !metadata.has(key) && canonical(before[key]) !== canonical(after[key]));
}
function indexNodes(nodes: unknown[]): Map<unknown, Data> | null {
  const index = new Map<unknown, Data>();
  for (const value of nodes) {
    const node = object(value); const id = node.id;
    if (!(typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 || typeof id === 'string' && id.length > 0) || index.has(id)) return null;
    index.set(id, node);
  }
  return index;
}
export function comparePreview(original: unknown[], processed: unknown[]) {
  const before = indexNodes(original); const after = indexNodes(processed);
  if (!before || !after) return null;
  const fields = new Map<unknown, string[]>();
  const changed = processed.filter(value => {
    const node = object(value); const previous = before.get(node.id);
    if (!previous) return false;
    const keys = changedFields(previous, node);
    if (!keys.length) return false;
    fields.set(node.id, keys); return true;
  });
  return {
    before, after, fields, changed,
    removed: original.filter(value => !after.has(object(value).id)),
    added: processed.filter(value => !before.has(object(value).id)),
  };
}
export function matchesPreviewNode(value: unknown, query: string, previous?: Data): boolean {
  if (!query.trim()) return true;
  const node = object(value);
  const search = [node.name, previous?.name, node.type, node.server, node.port, node._subName, node._subDisplayName].map(value => String(value ?? '')).join(' ').toLocaleLowerCase();
  return search.includes(query.trim().toLocaleLowerCase());
}
