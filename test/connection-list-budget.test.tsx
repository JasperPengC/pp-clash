// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConnectionsPage } from '../src/pages/Connections';
import { useApp } from '../src/store/app';
import { useViewPreferences } from '../src/store/view-preferences';
import { api } from '../src/core/api';
vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, api: { ...actual.api, mihomo: vi.fn() } };
});
let host: HTMLDivElement; let root: Root;
beforeEach(() => {
  useViewPreferences.setState(useViewPreferences.getInitialState(), true);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  useApp.setState({ ...useApp.getInitialState(), kernelPhase: 'running', notify: vi.fn() });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks(); });
it.each([false, true])('一万条连接及进程展开保持有界DOM，末尾连接和操作身份正确（独立进程=%s）', async separate => {
  const count = 10000;
  vi.mocked(api.mihomo).mockImplementation(async method => method === 'DELETE' ? {} : ({ connections: Array.from({ length: count }, (_, i) => ({
    id: `conn-${i}`, upload: i, download: i, start: new Date(100000000 + (count - i) * 1000).toISOString(),
    metadata: { host: `host-${i}.invalid`, process: separate ? `process-${String(i).padStart(5, '0')}` : 'browser' },
  })) }));
  await act(async () => root.render(createElement(ConnectionsPage)));
  expect(host.querySelectorAll('.conn-row').length).toBeLessThanOrEqual(30);
  const list = host.querySelector<HTMLElement>('[aria-label="活动连接列表"]')!;
  expect(list).toBeTruthy();
  await act(async () => list.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
  expect(list.textContent).toContain(`host-${count - 1}.invalid`);
  const last = [...list.querySelectorAll<HTMLElement>('.conn-row')].find(row => row.textContent?.includes(`host-${count - 1}.invalid`))!;
  await act(async () => last.querySelector<HTMLButtonElement>('[aria-label="断开此连接"]')!.click());
  expect(api.mihomo).toHaveBeenCalledWith('DELETE', `/connections/conn-${count - 1}`);
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('.seg-btn')].find(button => button.textContent === '按进程')!.click());
  expect(host.querySelectorAll('.proc-row').length).toBeLessThanOrEqual(30);
  if (!separate) {
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="展开 browser 的连接"]')!.click());
    const groups = host.querySelector<HTMLElement>('[aria-label="进程连接列表"]')!;
    await act(async () => groups.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    expect(groups.textContent).toContain(`host-${count - 2}.invalid`);
    expect(host.querySelectorAll('.conn-row').length).toBeLessThanOrEqual(30);
  }
  const search = host.querySelector<HTMLInputElement>('[aria-label="搜索连接"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'host-8765.invalid');
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(host.querySelector('.proc-row')?.textContent).toContain('1 条连接');
});
