// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { WebDavBackup } from '../src/components/WebDavBackup';
import { api } from '../src/core/api';
import { webdavService } from '../src/core/webdav-service';
import { useApp } from '../src/store/app';

afterEach(() => { vi.restoreAllMocks(); });
it('持久设置下历史分页、解密预览与明确确认恢复，摘要包含SubStore', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const name = 'ppclash-1780000000000-00112233445566778899aabbccddeeff.ppbackup';
  vi.spyOn(api, 'getWebDavSettings').mockResolvedValue({ settings: { endpoint: 'https://dav.example/files/', directory: 'backups', username: '', deviceName: 'Mac', schedule: 'off', retention: 7 }, deviceId: 'local', configured: true, hasPassword: true, hasBackupPassphrase: true, credentialStore: { backend: 'macosKeychain', status: 'available' } });
  vi.spyOn(webdavService, 'status').mockResolvedValue({ phase: 'idle', lastSuccessAt: null, nextDueAt: null, error: null });
  const list = vi.spyOn(webdavService, 'history').mockImplementation(async (offset = 0, limit = 10) => ({ items: Array.from({ length: offset ? 1 : 10 }, (_, index) => ({ name: index === 0 ? name : name + index, deviceName: 'Mac', createdAt: 1780000000000 - index, size: 2048, isCurrentDevice: true })), total: 11, offset, limit }));
  const preview = vi.spyOn(webdavService, 'preview').mockResolvedValue({ device: 'Mac', profiles: 2, collections: 1, digest: 'known-hash', subStoreEntries: 3 } as Awaited<ReturnType<typeof webdavService.preview>>);
  const restore = vi.fn().mockRejectedValue(new Error('备份已变化，请重新预览')); const original = useApp.getState().restoreBackup; useApp.setState({ restoreBackup: restore });
  const button = (text: string) => [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === text)!;
  const click = async (text: string) => act(async () => button(text).click());
  try {
    await act(async () => root.render(<WebDavBackup />)); await click('备份历史');
    expect(list).toHaveBeenCalledWith(0, 10); expect(document.querySelectorAll('.history-table-row')).toHaveLength(10);
    await click('下一页'); expect(list).toHaveBeenCalledWith(10, 10); expect(document.querySelectorAll('.history-table-row')).toHaveLength(1);
    await click('上一页'); await click('恢复'); expect(button('解密并预览').disabled).toBe(true);
    await act(async () => { const element = document.querySelector<HTMLInputElement>('[aria-label="恢复云备份口令"]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, 'local test pass'); element.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => document.querySelector('[aria-label="恢复云备份口令"]')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(preview).toHaveBeenCalledWith({ name, passphrase: 'local test pass' });
    expect(document.body.textContent).toContain('2 个订阅 · 1 个组合 · 3 个 Sub-Store 条目'); expect(restore).not.toHaveBeenCalled();
    await click('确认恢复'); expect(restore).toHaveBeenCalledWith({ savedWebDav: true, name, digest: 'known-hash', passphrase: 'local test pass' });
    expect(document.querySelector('[role=alert]')?.textContent).toContain('请重新预览');
    await click('返回'); expect(button('解密并预览').disabled).toBe(false);
  } finally { await act(async () => root.unmount()); useApp.setState({ restoreBackup: original }); host.remove(); }
});

it('Android云备份入口打开共享密码表单并加载加密凭据元数据', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(api, 'getWebDavSettings').mockResolvedValue({ settings: { endpoint: '', directory: 'backups', username: '', deviceName: 'Android', schedule: 'off', retention: 7 }, deviceId: 'local', configured: false, hasPassword: false, hasBackupPassphrase: false, credentialStore: { backend: 'androidKeystore', status: 'available' } });
  vi.spyOn(webdavService, 'status').mockResolvedValue({ phase: 'idle', lastSuccessAt: null, nextDueAt: null, error: null });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<WebDavBackup mobile />));
    await act(async () => host.querySelector('button')!.click());
    expect(document.querySelector<HTMLInputElement>('[aria-label="服务器密码"]')?.type).toBe('password');
    expect(document.querySelector<HTMLInputElement>('[aria-label="备份口令"]')?.type).toBe('password');
    expect(document.body.textContent).toContain('备份历史');
  } finally { await act(async () => root.unmount()); host.remove(); }
});
