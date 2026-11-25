/** 官方对象保留未知字段，编辑器不得用已知字段重建整条记录。 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Kind = 'sub' | 'collection' | 'file';
export type OfficialKind = 'sub' | 'col' | 'file';
export interface Processor {
  type: string;
  args?: Record<string, unknown>;
  disabled?: boolean;
  [key: string]: unknown;
}
export interface Entry {
  name: string;
  displayName?: string;
  remark?: string;
  tag?: string | string[];
  process?: Processor[];
  [key: string]: unknown;
}
export interface Subscription extends Entry {
  url?: string;
  content?: string;
  source?: 'local' | 'remote' | 'local-first' | 'remote-first';
  mergeSources?: boolean;
  ignoreFailedRemoteSub?: boolean;
}
export interface Collection extends Entry { subscriptions: string[] }
export interface File extends Entry { content?: string; url?: string; type?: string }
export interface Artifact extends Entry {
  type: OfficialKind | string;
  source: string;
  platform?: string;
  syncOption?: Record<string, unknown>;
}
export interface Share extends Entry {
  token: string;
  type: OfficialKind;
  expires?: number;
  maxUses?: number;
}
export interface Archive {
  id: string;
  itemType: 'sub' | 'col' | 'file' | 'artifact' | 'share';
  archivedAt: number;
  name: string;
  snapshot: Record<string, unknown>;
  [key: string]: unknown;
}
export interface SubStoreSnapshot {
  schemaVersion: 1;
  engineVersion: '2.44.16';
  files: { 'root.json': Record<string, JsonValue>; 'sub-store.json': Record<string, JsonValue> };
}
export const subStoreContracts = {
  subscription: { list: '/api/subs', item: '/api/sub/', preview: '/api/preview/sub', download: '/download/' },
  collection: { list: '/api/collections', item: '/api/collection/', preview: '/api/preview/collection', download: '/download/collection/' },
  file: { list: '/api/files', item: '/api/file/', whole: '/api/wholeFile/', preview: '/api/preview/file', share: '/share/file/' },
  artifact: { list: '/api/artifacts', item: '/api/artifact/', sync: '/api/sync/artifact/', syncAll: '/api/sync/artifacts' },
  share: { list: '/api/tokens', create: '/api/token', item: '/api/token/' },
  archive: { list: '/api/archives', item: '/api/archives/' },
  module: { list: '/api/modules', item: '/api/module/' },
  settings: '/api/settings',
} as const;
