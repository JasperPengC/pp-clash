// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { SettingsPage } from '../src/pages/Settings';
import { DEFAULT_SETTINGS, useApp } from '../src/store/app';
import { useViewPreferences } from '../src/store/view-preferences';

vi.mock('../src/core/api', async original => {
  const actual = await original<typeof import('../src/core/api')>();
  return { ...actual, isTauri: false, api: { ...actual.api, listBackups: vi.fn().mockResolvedValue([]) } };
});
let host: HTMLDivElement; let root: Root;
const update = vi.fn();
beforeEach(async () => {
  useViewPreferences.setState(useViewPreferences.getInitialState(), true);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  update.mockReset();
  useApp.setState({ settings: { ...DEFAULT_SETTINGS, githubProxy: 'https://custom.example/' }, profiles: [], groups: [],
    activeId: null, updateSettings: update, checkingUpdate: false, updateInfo: null });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(SettingsPage)));
  await click('下载');
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function enter(label: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find(button => button.textContent === text)!;
  expect(button).toBeTruthy(); await act(async () => button.click());
}
const proxyChoice = () => host.querySelector<HTMLButtonElement>('[aria-label="GitHub 下载代理"]')!;
it('默认只打开外观分类，主题拥有完整区域；搜索跨分类且清空后回到原分类', async () => {
  await act(async () => root.render(null));
  useViewPreferences.setState(useViewPreferences.getInitialState(), true);
  await act(async () => root.render(createElement(SettingsPage)));
  expect([...host.querySelectorAll('.settings-section')].map(section => section.getAttribute('aria-label'))).toEqual(['外观']);
  expect(host.querySelector('.settings-category[aria-pressed="true"]')?.textContent).toBe('外观');
  expect(host.querySelectorAll('.settings-theme-option')).toHaveLength(3);
  expect([...host.querySelectorAll('.settings-category')].some(button => button.textContent === '全部')).toBe(false);
  await enter('搜索设置', 'backup');
  expect(host.querySelector('.settings-section')?.getAttribute('aria-label')).toBe('备份与恢复');
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="清空设置搜索"]')!.click());
  expect(host.querySelector('.settings-section')?.getAttribute('aria-label')).toBe('外观');
  expect(update).not.toHaveBeenCalled();
});
it('设置工作区使用页面完整内容宽度，不单独居中限宽', () => {
  const style = document.createElement('style');
  style.textContent = readFileSync('src/styles/settings.css', 'utf8');
  document.head.append(style);
  try {
    const workspace = host.querySelector<HTMLElement>('.settings-workspace')!;
    expect(getComputedStyle(workspace).width).toBe('100%');
    expect(getComputedStyle(workspace).maxWidth).toBe('none');
    expect(getComputedStyle(workspace).marginInline).toBe('0');
  } finally { style.remove(); }
});
it('设置区内容容器限定视口高度并独立滚动', () => {
  const style = document.createElement('style');
  style.textContent = readFileSync('src/styles/settings.css', 'utf8');
  const desktop = document.createElement('style');
  desktop.textContent = readFileSync('src/styles/theme.css', 'utf8');
  document.head.append(style);
  document.head.append(desktop);
  try {
    const page = document.createElement('div');
    page.className = 'page-anim';
    host.append(page);
    const scroll = document.createElement('div');
    scroll.className = 'page-scroll';
    page.append(scroll);
    expect(getComputedStyle(page).minHeight).toBe('0');
    expect(getComputedStyle(scroll).overflowY).toBe('auto');
    expect(getComputedStyle(scroll).flex).toContain('1');
  } finally { style.remove(); desktop.remove(); }
});
it('分类导航只显示当前分类，且不提供应用自带的固定出口开关', async () => {
  const category = [...host.querySelectorAll<HTMLButtonElement>('.settings-category')]
    .find(button => button.textContent?.trim() === '诊断与日志')!;
  await act(async () => category.click());
  expect([...host.querySelectorAll('.settings-section')].map(section => section.getAttribute('aria-label')))
    .toEqual(['诊断与日志']);
  expect(host.querySelector('[aria-label="GitHub 固定出口"]')).toBeNull();
});
async function chooseProxy(text: string) {
  await act(async () => proxyChoice().click());
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(button => button.textContent === text)!;
  expect(option).toBeTruthy();
  await act(async () => option.click());
}
async function startWithProxy(value: string) {
  await act(async () => root.render(null));
  useApp.setState(state => ({ settings: { ...state.settings, githubProxy: value } }));
  await act(async () => root.render(createElement(SettingsPage)));
  await click('下载');
}
it('字号同义词只显示文字大小，清空后回到原分类且不改变设置', async () => {
  await enter('搜索设置', '字号');
  expect(host.querySelectorAll('.settings-section')).toHaveLength(1);
  expect(host.querySelector('.settings-section')?.getAttribute('aria-label')).toBe('外观');
  expect(host.querySelector('[aria-label="文字大小"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="开机自启"]')).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="清空设置搜索"]')!.click());
  expect(host.querySelectorAll('.settings-section')).toHaveLength(1);
  expect(host.querySelector('.settings-section')?.getAttribute('aria-label')).toBe('下载');
  expect(update).not.toHaveBeenCalled();
});
it('分类搜索跨分类找到备份，未知词提供清除入口', async () => {
  await click('下载');
  expect(host.querySelectorAll('.settings-section')).toHaveLength(1);
  await enter('搜索设置', 'backup');
  expect(host.querySelector('.settings-section')?.getAttribute('aria-label')).toBe('备份与恢复');
  await enter('搜索设置', '不会存在的设置');
  expect(host.querySelector('.settings-section')).toBeNull();
  await click('清除搜索');
  expect(host.querySelectorAll('.settings-section')).toHaveLength(1);
  expect(host.querySelector('.settings-section')?.getAttribute('aria-label')).toBe('下载');
});
it('切分类和搜索保留自定义前缀草稿，只在明确保存时提交', async () => {
  await enter('自定义 GitHub 下载代理', 'https://draft.example/');
  await click('外观'); await enter('搜索设置', '下载');
  expect(update).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLInputElement>('[aria-label="自定义 GitHub 下载代理"]')?.value).toBe('https://draft.example/');
  await click('保存前缀');
  expect(update).toHaveBeenCalledWith({ githubProxy: 'https://draft.example/' });
});

it.each(['auto', '', 'https://gh-proxy.org/'])('从预设 %s 进入自定义显示待保存，草稿为空且不提前应用', async value => {
  await startWithProxy(value);
  await chooseProxy('自定义…');
  expect(proxyChoice().textContent).toContain('自定义（待保存）');
  expect(host.querySelector<HTMLInputElement>('[aria-label="自定义 GitHub 下载代理"]')!.value).toBe('');
  expect([...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '保存前缀')!.disabled).toBe(true);
  expect(update).not.toHaveBeenCalled();
  expect(useApp.getState().settings.githubProxy).toBe(value);
});

it('自定义草稿切分类和切换其他预设后保留，保存成功才成为当前自定义', async () => {
  await startWithProxy('auto');
  update.mockImplementation(patch => useApp.setState(state => ({ settings: { ...state.settings, ...patch } })));
  await chooseProxy('自定义…');
  await enter('自定义 GitHub 下载代理', ' https://draft.example/ ');
  await click('外观'); await click('下载');
  expect(proxyChoice().textContent).toContain('自定义（待保存）');
  expect(update).not.toHaveBeenCalled();
  await chooseProxy('直连');
  expect(proxyChoice().textContent).toContain('直连');
  expect(useApp.getState().settings.githubProxy).toBe('');
  expect(host.querySelector('[aria-label="自定义 GitHub 下载代理"]')).toBeNull();
  await chooseProxy('自定义…');
  expect(host.querySelector<HTMLInputElement>('[aria-label="自定义 GitHub 下载代理"]')!.value).toBe(' https://draft.example/ ');
  update.mockClear();
  await click('保存前缀');
  expect(update).toHaveBeenCalledExactlyOnceWith({ githubProxy: 'https://draft.example/' });
  expect(useApp.getState().settings.githubProxy).toBe('https://draft.example/');
  expect(proxyChoice().textContent?.trim()).toBe('自定义');
});

it('自定义保存失败保留草稿与待保存状态，允许明确重试', async () => {
  await startWithProxy('auto');
  await chooseProxy('自定义…');
  await enter('自定义 GitHub 下载代理', 'https://retry.example/');
  update.mockImplementationOnce(() => { throw new Error('save failed'); });
  await click('保存前缀');
  expect(useApp.getState().settings.githubProxy).toBe('auto');
  expect(host.querySelector<HTMLInputElement>('[aria-label="自定义 GitHub 下载代理"]')!.value).toBe('https://retry.example/');
  expect(proxyChoice().textContent).toContain('自定义（待保存）');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('save failed');
  update.mockImplementation(patch => useApp.setState(state => ({ settings: { ...state.settings, ...patch } })));
  await click('保存前缀');
  expect(proxyChoice().textContent?.trim()).toBe('自定义');
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it('已有自定义 URL 可直接编辑，修改前不显示待保存，改动后仍由明确保存提交', async () => {
  expect(proxyChoice().textContent?.trim()).toBe('自定义');
  expect(host.querySelector<HTMLInputElement>('[aria-label="自定义 GitHub 下载代理"]')!.value).toBe('https://custom.example/');
  await enter('自定义 GitHub 下载代理', 'https://new.example/');
  expect(proxyChoice().textContent).toContain('自定义（待保存）');
  expect(update).not.toHaveBeenCalled();
  expect(useApp.getState().settings.githubProxy).toBe('https://custom.example/');
});

it.each([['自动（优先代理）', 'auto'], ['直连', ''], ['gh-proxy.org', 'https://gh-proxy.org/']])('选择普通预设 %s 立即保存并关闭自定义字段', async (label, value) => {
  update.mockImplementation(patch => useApp.setState(state => ({ settings: { ...state.settings, ...patch } })));
  await chooseProxy(label);
  expect(update).toHaveBeenCalledExactlyOnceWith({ githubProxy: value });
  expect(proxyChoice().textContent?.trim()).toBe(label);
  expect(host.querySelector('[aria-label="自定义 GitHub 下载代理"]')).toBeNull();
});

it('内部自定义选择值不会作为 URL 草稿显示', async () => {
  await startWithProxy('__custom__');
  expect(host.querySelector<HTMLInputElement>('[aria-label="自定义 GitHub 下载代理"]')!.value).toBe('');
  expect(update).not.toHaveBeenCalled();
});

it('设置搜索框是有名称的真实输入，清空后焦点回到搜索框', async () => {
  const input = host.querySelector<HTMLInputElement>('[aria-label="搜索设置"]')!;
  expect(input).toBeTruthy(); expect(input.tagName).toBe('INPUT');
  await enter('搜索设置', '字号');
  expect(host.querySelectorAll('.settings-section')).toHaveLength(1);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="清空设置搜索"]')!.click());
  expect(host.querySelectorAll('.settings-section')).toHaveLength(1);
  expect(host.querySelector('.settings-section')?.getAttribute('aria-label')).toBe('下载');
  expect(document.activeElement).toBe(input);
});
