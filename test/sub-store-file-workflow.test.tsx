// @vitest-environment happy-dom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EntryEditor } from '../src/components/sub-store/EntryEditor';
import { validateEntry, type Entry } from '../src/components/sub-store/model';
import { startTestSubStore } from './helpers/sub-store-engine';
import { load } from 'js-yaml';
import { writeFileSync } from 'node:fs';

// 保留真实表单；CodeMirror的几何测量不适用于happy-dom。
vi.mock('../src/components/CodeEditor', () => ({ default: ({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled: boolean }) => createElement('textarea', { 'aria-label': '代码内容', value, disabled, onChange: (event: { target: { value: string } }) => onChange(event.target.value) }) }));
let root: Root; let host: HTMLDivElement; let saved: Entry;
const sources = [{ name: 'qa-sub', displayName: '测试来源' }];
const collections = [{ name: 'qa-col', displayName: '测试组合' }];
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const click = async (element: Element | undefined | null) => {
  expect(element, '操作入口应存在').toBeTruthy(); await act(async () => (element as HTMLElement).click());
};
const button = (label: string) => [...host.querySelectorAll('button')].find(element => element.textContent?.trim() === label);
const choose = async (label: string, option: string) => {
  await click(host.querySelector(`[aria-label="${label}"]`));
  await click([...document.querySelectorAll('[role="option"]')].find(element => element.textContent?.trim() === option));
};
async function editor(entry: Entry, busy = false) {
  function Harness() {
    const [value, setValue] = useState(entry); saved = value;
    return <EntryEditor kind="file" entry={value} sources={sources} collections={collections} busy={busy} onChange={setValue} onValidity={() => {}} onJsonDraft={() => {}} onSectionChange={() => {}} />;
  }
  await act(async () => root.render(<Harness />));
}
const mihomo = (patch: Partial<Entry> = {}): Entry => ({ name: 'F', type: 'mihomoConfig', sourceType: 'subscription', sourceName: 'qa-sub', process: [], ...patch });

it('普通文件可转为Mihomo，选择真实来源名称且保留内容及高级字段', async () => {
  await editor({ name: 'F', source: 'local', content: 'proxies: []', url: 'https://example.invalid/old', advanced: { preserve: 9 }, process: [] });
  await choose('文件类型', 'Mihomo 配置');
  await choose('Mihomo 内容来源', '已有来源'); await choose('选择来源', '测试来源');
  expect(saved).toMatchObject({ type: 'mihomoConfig', sourceType: 'subscription', sourceName: 'qa-sub', content: 'proxies: []', url: 'https://example.invalid/old', advanced: { preserve: 9 } });
});
it('组合选择写入官方名称，不保留同名来源的旧引用', async () => {
  await editor(mihomo()); await choose('Mihomo 内容来源', '已有组合');
  expect(saved.sourceName).toBe(''); await choose('选择组合', '测试组合');
  expect(saved).toMatchObject({ sourceType: 'collection', sourceName: 'qa-col' });
});
it.each(['mihomoProfile', 'future-file'])('重新选择%s当前类型不迁移或删除导入字段', async type => {
  const entry = mihomo({ type, unknown: 8 }); await editor(entry);
  await choose('文件类型', type === 'mihomoProfile' ? 'Mihomo 配置' : '当前类型：future-file');
  expect(saved).toEqual(entry);
});
it('缺失引用显示原名称，校验拒绝保存而不替换为首个来源', async () => {
  await editor(mihomo({ sourceName: 'deleted-sub' }));
  expect(saved.sourceName).toBe('deleted-sub'); expect(host.textContent).toContain('deleted-sub');
  expect(host.textContent).toContain('已不存在');
  expect(() => validateEntry('file', saved, { sources, collections })).toThrow('已不存在');
  await choose('选择来源', '测试来源');
  expect(() => validateEntry('file', saved, { sources, collections })).not.toThrow();
});
it('本地和远程的完整配置/仅节点用途明确，切换保留正文和链接', async () => {
  await editor(mihomo({ sourceType: 'local', content: 'mixed-port: 7892\nproxies: []', url: 'https://example.invalid/old', extra: 'kept' }));
  await choose('内容用途', '仅提取节点');
  expect(saved.mode).toBe('proxy'); expect(host.textContent).toContain('端口、规则等配置不会保留');
  await choose('Mihomo 内容来源', '远程链接'); await choose('内容用途', '完整配置');
  expect(saved).toMatchObject({ sourceType: 'remote', mode: 'config', content: 'mixed-port: 7892\nproxies: []', url: 'https://example.invalid/old', extra: 'kept' });
});
it('基础模板由明确操作追加，已有处理器顺序及字段保真', async () => {
  const previous = { type: 'Script Operator', args: { mode: 'script', content: 'log-level: info', custom: 9 }, disabled: true };
  await editor(mihomo({ process: [previous] })); await click(button('添加基础配置模板'));
  expect(saved.process).toHaveLength(2); expect(saved.process?.[0]).toEqual(previous);
  const added = saved.process![1]; expect(added).toMatchObject({ type: 'Script Operator', args: { mode: 'script' }, disabled: false });
  const config = load((added.args as { content: string }).content) as Record<string, unknown>;
  expect(config).toMatchObject({ mode: 'rule', 'proxy-groups': [{ name: 'PROXY', type: 'select', 'include-all': true, proxies: ['DIRECT'] }], rules: ['MATCH,PROXY'] });
  expect(config).not.toHaveProperty('mixed-port'); expect(config).not.toHaveProperty('tun'); expect(config).not.toHaveProperty('dns');
});
it('完整本地配置不提供覆盖现有分组的快捷模板；忙碌时来源选项禁用', async () => {
  await editor(mihomo({ sourceType: 'local', mode: 'config', content: 'rules: []' }), true);
  expect(button('添加基础配置模板')).toBeUndefined();
  expect(host.querySelector<HTMLButtonElement>('[aria-label="文件类型"]')?.disabled).toBe(true);
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Mihomo 内容来源"]')?.disabled).toBe(true);
});
it.each([{ invalid: 'preserve-for-repair' }, '', false, 0])('导入无效process=%j时不能通过添加模板覆盖原数据', async process => {
  const entry = mihomo({ process: process as unknown as Entry['process'] });
  await editor(entry);
  expect(button('添加基础配置模板')?.disabled).toBe(true);
  await click(button('添加基础配置模板'));
  expect(saved.process).toEqual(process);
});

it('真实表单参数完成来源/组合/本地远程用途与模板的官方引擎保存预览导出', async () => {
  const engine = await startTestSubStore('.cache/mihomo-file-workflow-20261123');
  const nodes = [{ name: 'QA节点', type: 'ss', server: '192.0.2.10', port: 443, cipher: 'aes-128-gcm', password: 'synthetic-only' }];
  const config = 'mixed-port: 45801\nproxies:\n  - {name: QA节点, type: ss, server: 192.0.2.10, port: 443, cipher: aes-128-gcm, password: synthetic-only}\n';
  const remote = await engine.serveText(config);
  const results: unknown[] = [];
  try {
    await engine.call('/api/subs', { name: 'qa-sub', source: 'local', content: JSON.stringify({ proxies: nodes }), process: [] }, 'POST', 201);
    await engine.call('/api/collections', { name: 'qa-col', subscriptions: ['qa-sub'], process: [] }, 'POST', 201);
    for (const [sourceType, mode] of [['subscription', 'config'], ['collection', 'config'], ['local', 'config'], ['local', 'proxy'], ['remote', 'config'], ['remote', 'proxy'], ['none', 'config']] as const) {
      await editor(mihomo({ name: `qa-${results.length}`, sourceType: 'subscription', content: sourceType === 'remote' ? 'mixed-port: 9999\n' : config, url: remote.url }));
      await choose('Mihomo 内容来源', { subscription: '已有来源', collection: '已有组合', local: '本地内容', remote: '远程链接', none: '空配置' }[sourceType]);
      if (sourceType === 'collection') await choose('选择组合', '测试组合');
      if (sourceType === 'local' || sourceType === 'remote') await choose('内容用途', mode === 'config' ? '完整配置' : '仅提取节点');
      if (sourceType === 'subscription' || sourceType === 'collection' || mode === 'proxy' || sourceType === 'none') await click(button('添加基础配置模板'));
      const request = structuredClone(saved);
      const preview = await engine.call('/api/preview/file', request, 'POST');
      await engine.call('/api/files', request, 'POST', 201);
      expect(await engine.call(`/api/wholeFile/${request.name}`)).toMatchObject(request);
      const output = await engine.http(`/api/file/${request.name}`); expect(output.status, output.text).toBe(200);
      const parsed = load(output.text) as Record<string, unknown>;
      expect(parsed.proxies ?? []).toEqual(sourceType === 'none' ? [] : expect.arrayContaining([expect.objectContaining({ name: 'QA节点', server: '192.0.2.10' })]));
      if ((sourceType === 'local' || sourceType === 'remote') && mode === 'config') expect(parsed['mixed-port']).toBe(45801);
      else { expect(parsed).not.toHaveProperty('mixed-port'); expect(parsed['proxy-groups']).toEqual([{ name: 'PROXY', type: 'select', 'include-all': true, proxies: ['DIRECT'] }]); }
      expect(preview.processed).toBe(output.text);
      writeFileSync(`${engine.data}/${request.name}.yaml`, output.text); results.push({ request, preview, parsed });
    }
    writeFileSync(`${engine.data}/acceptance.json`, JSON.stringify({ engine: '2.44.16', realUiParameters: true, results }, null, 2));
  } finally { await remote.close(); await engine.close(); }
}, 30000);
