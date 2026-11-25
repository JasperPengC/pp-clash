import { invoke } from '@tauri-apps/api/core';
import type { SubStoreSnapshot } from './contracts';
import { readSubStoreFailure, subStoreError } from './failure';
import type { SubStorePreview } from './preview';
export type SubStorePhase = 'stopped' | 'starting' | 'running' | 'failed' | 'unsupported';
export interface SubStoreStatus { phase: SubStorePhase; version: string; error?: string }
export type SubStoreMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
export const getSubStoreStatus = () => invoke<SubStoreStatus>('sub_store_status');
export const startSubStore = () => invoke<SubStoreStatus>('sub_store_start');
export const stopSubStore = () => invoke<void>('sub_store_stop');
export const snapshotSubStore = () => invoke<SubStoreSnapshot>('sub_store_snapshot');
export const restoreSubStoreSnapshot = (snapshot: SubStoreSnapshot) => invoke<void>('sub_store_restore_snapshot', { snapshot });

/** 响应包裹由原生层校验，JSON返回success.data，下载文件保留原始文本。 */
export async function requestSubStore<T = unknown>(path: string, body?: unknown, method?: SubStoreMethod, preview?: SubStorePreview): Promise<T> {
  const request = { path, method: method ?? (body === undefined ? 'GET' : 'POST'), ...(body === undefined ? {} : { body }) };
  const text = await (preview ? preview.invoke(request) : invoke<string>('sub_store_request', { request })).catch(reason => {
    const failure = readSubStoreFailure(reason);
    const original = reason instanceof Error ? reason.message : String(reason);
    if (failure.processor || failure.trace || failure.message !== original) throw subStoreError(reason);
    throw reason;
  });
  if (path.startsWith('/download/') || path.startsWith('/share/') ||
      ((method ?? (body === undefined ? 'GET' : 'POST')) === 'GET' && path.startsWith('/api/file/'))) return text as T;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return text as T; }
  if (value && typeof value === 'object' && 'status' in value) {
    const envelope = value as { status: string; data?: unknown; error?: unknown };
    if (envelope.status !== 'success') throw subStoreError(value);
    return envelope.data as T;
  }
  return value as T;
}
export { subStoreContracts } from './contracts';
export type { Entry, Kind, Processor } from './contracts';
