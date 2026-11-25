import { invoke } from '@tauri-apps/api/core';
import type { WebDavBackupPreview, WebDavConnectionTestResult, WebDavSaveRequest, WebDavSettingsSnapshot, WebDavTestRequest } from './api';

export type WebDavBackupPhase = 'idle' | 'running' | 'error' | 'disabled';
export interface WebDavBackupStatus {
  phase: WebDavBackupPhase;
  lastSuccessAt: number | null;
  nextDueAt: number | null;
  error: string | null;
}
export interface WebDavBackupEntry {
  name: string;
  deviceId?: string | null;
  deviceName: string;
  createdAt: number | null;
  size: number | null;
  version?: number | null;
  isCurrentDevice: boolean;
}
export interface WebDavBackupHistory {
  items: WebDavBackupEntry[];
  total: number;
  offset: number;
  limit: number;
}
export interface WebDavBackupResult {
  status: WebDavBackupStatus;
  record: WebDavBackupEntry;
  cleanupError: string | null;
}
export interface WebDavDeleteResult { name: string; deleted: boolean }
export interface WebDavSavedPreviewRequest { name: string; passphrase: string }
export interface WebDavSavedRestoreRequest extends WebDavSavedPreviewRequest { digest: string; session: string }

/** 原生层读取保存的凭据；任务调用只传操作参数。 */
export const webdavService = {
  getSettings: () => invoke<WebDavSettingsSnapshot>('get_webdav_settings'),
  saveSettings: (request: WebDavSaveRequest) => invoke<WebDavSettingsSnapshot>('save_webdav_settings', { request }),
  testConnection: (request: WebDavTestRequest) => invoke<WebDavConnectionTestResult>('test_webdav_connection', { request }),
  status: () => invoke<WebDavBackupStatus>('webdav_backup_status'),
  backupNow: () => invoke<WebDavBackupResult>('webdav_backup_now'),
  history: (offset = 0, limit = 20) => invoke<WebDavBackupHistory>('webdav_backup_history', { offset, limit }),
  delete: (name: string) => invoke<WebDavDeleteResult>('webdav_backup_delete', { name }),
  preview: (request: WebDavSavedPreviewRequest) => invoke<WebDavBackupPreview>('webdav_saved_preview', { ...request }),
  restore: (request: WebDavSavedRestoreRequest) => invoke<void>('webdav_saved_restore', { ...request }),
};
