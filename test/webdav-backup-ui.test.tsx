// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { WebDavBackup } from '../src/components/WebDavBackup';
import { api } from '../src/core/api';
import { useApp } from '../src/store/app';

afterEach(() => { vi.restoreAllMocks(); });
it.each([false, true])('连接、预览与明确确认恢复（移动布局 %s）', async mobile => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const name = 'ppclash-1780000000000-00112233445566778899aabbccddeeff.ppbackup';
  const list = vi.spyOn(api, 'webdavList').mockResolvedValue(Array.from({ length: 11 }, (_, i) => i ? name.replace('1780000000000', String(1780000000000 - i)) : name));
  const preview = vi.spyOn(api, 'webdavPreview').mockResolvedValue({ device: 'Mac', profiles: 2, collections: 1, digest: 'known-hash' });
  const restore = vi.fn().mockRejectedValue(new Error('备份已变化，请重新预览'));
  const original = useApp.getState().restoreBackup;
  useApp.setState({ restoreBackup: restore });
  const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text)!;
  const click = async (text: string) => act(async () => button(text).click());
  const input = async (selector: string, value: string) => act(async () => {
    const element = document.querySelector<HTMLInputElement>(selector)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  try {
    await act(async () => root.render(<WebDavBackup mobile={mobile} />));
    await click(mobile ? 'WebDAV 云备份' : '管理云备份');
    await input('input[type="url"]', 'https://dav.example/files/');
    await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(list).toHaveBeenCalledWith({ endpoint: 'https://dav.example/files/', username: '', password: '' });
    expect(document.querySelectorAll('.webdav-backup li')).toHaveLength(10);
    await click('下一页');
    expect(document.querySelectorAll('.webdav-backup li')).toHaveLength(1);
    await click('上一页');
    expect(button('预览').disabled).toBe(true);
    await input('input[type="password"]', 'local test pass');
    await click('预览');
    expect(preview).toHaveBeenCalledWith(expect.any(Object), name, 'local test pass');
    expect(document.body.textContent).toContain('2 个订阅（含 1 个组合）');
    expect(restore).not.toHaveBeenCalled();
    await click('确认恢复');
    expect(restore).toHaveBeenCalledWith(expect.objectContaining({ name, digest: 'known-hash', passphrase: 'local test pass' }));
    expect(document.querySelector('[role=alert]')?.textContent).toContain('请重新预览');
    await click('返回');
    await click('更换目录');
    expect(document.querySelector<HTMLInputElement>('input[type=url]')?.value).toBe('');
  } finally {
    await act(async () => root.unmount());
    useApp.setState({ restoreBackup: original });
    host.remove();
  }
});
