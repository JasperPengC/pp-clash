// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RulesPage } from '../src/pages/Rules';
import { useApp } from '../src/store/app';
import { useViewPreferences } from '../src/store/view-preferences';
import { api } from '../src/core/api';
vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, isTauri: true, api: { ...actual.api, mihomo: vi.fn() } };
});
let host: HTMLDivElement; let root: Root;
const initial = useApp.getInitialState();
beforeEach(() => {
  useViewPreferences.setState(useViewPreferences.getInitialState(), true);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  useApp.setState({ ...initial, kernelPhase: 'running', connectedAt: 1, notify: vi.fn() });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const seed = (count: number) => {
  const rules = Array.from({ length: count }, (_, i) => `DOMAIN,site-${i}.invalid,DIRECT`);
  useApp.setState({ activeId: 'large', profiles: [{ id: 'large', name: '大订阅', url: '', raw: JSON.stringify({ rules }), updatedAt: 1, userinfo: null, updateIntervalHours: null }],
    settings: { ...initial.settings, customRules: Array.from({ length: count }, (_, i) => ({ id: `rule-${i}`, type: 'DOMAIN', payload: `custom-${i}.invalid`, target: 'DIRECT', enabled: true })) } });
  vi.mocked(api.mihomo).mockResolvedValue({ rules: Array.from({ length: count }, (_, i) => ({ type: 'Domain', payload: `effective-${i}.invalid`, proxy: 'DIRECT' })) });
};
it('规则视图独立切换，保留编辑草稿和订阅搜索，只有当前列表占用内容区', async () => {
  seed(1000);
  await act(async () => root.render(createElement(RulesPage)));
  const tabs = () => [...host.querySelectorAll<HTMLButtonElement>('[aria-label="规则视图"] button')];
  expect(tabs()).toHaveLength(3);
  const panel = (name: string) => host.querySelector<HTMLElement>(`section[aria-label="${name}"]`)!;
  expect(panel('自定义规则').hidden).toBe(false);
  expect(panel('订阅规则').hidden).toBe(true);
  const enter = async (name: string, text: string) => act(async () => {
    const input = host.querySelector<HTMLInputElement>(`[aria-label="${name}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await enter('规则内容', 'draft.invalid');
  await act(async () => tabs()[1].click());
  await enter('搜索订阅规则', 'site-999.invalid');
  expect(panel('订阅规则').hidden).toBe(false);
  expect(panel('自定义规则').hidden).toBe(true);
  await act(async () => tabs()[2].click());
  expect(panel('当前生效规则').hidden).toBe(false);
  expect(host.querySelector<HTMLInputElement>('[aria-label="规则内容"]')!.value).toBe('draft.invalid');
  await act(async () => tabs()[1].click());
  expect(host.querySelector<HTMLInputElement>('[aria-label="搜索订阅规则"]')!.value).toBe('site-999.invalid');
  expect(panel('订阅规则').querySelectorAll('.sub-rule-row')).toHaveLength(1);
  expect(tabs()[1].getAttribute('aria-pressed')).toBe('true');
});
it.each([1000, 10000])('%i 条规则的三类列表保持有界DOM，末尾可达且编辑对应原始序号', async count => {
  seed(count);
  const update = vi.fn().mockResolvedValue(true); useApp.setState({ updateRuleEdits: update });
  await act(async () => root.render(createElement(RulesPage)));
  for (const selector of ['.custom-rule-row', '.sub-rule-row', '.kernel-rule-list .rule-row:not(.rule-head)']) {
    expect(host.querySelectorAll(selector).length).toBeGreaterThan(0);
    expect(host.querySelectorAll(selector).length).toBeLessThanOrEqual(40);
  }
  const viewport = host.querySelector<HTMLElement>('[aria-label="订阅规则列表"]')!;
  await act(async () => viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
  expect(viewport.textContent).toContain(`site-${count - 1}.invalid`);
  const last = [...viewport.querySelectorAll<HTMLElement>('.sub-rule-row')].find(row => row.textContent?.includes(`site-${count - 1}.invalid`))!;
  await act(async () => last.querySelector<HTMLButtonElement>('[aria-label="启用订阅规则"]')!.click());
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ edits: { [count - 1]: { enabled: false } } }));
  const input = host.querySelector<HTMLInputElement>('[aria-label="搜索订阅规则"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input, `site-${count-1}.invalid`);
    input.dispatchEvent(new Event('input',{bubbles:true}));
  });
  expect(host.querySelectorAll('.sub-rule-row')).toHaveLength(1);
  expect(viewport.textContent).toContain(`site-${count-1}.invalid`);
});
