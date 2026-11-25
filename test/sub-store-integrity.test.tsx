// @vitest-environment happy-dom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EntryEditor } from '../src/components/sub-store/EntryEditor';
import { type Entry } from '../src/components/sub-store/model';
import { startTestSubStore } from './helpers/sub-store-engine';

vi.mock('../src/components/CodeEditor', () => ({ default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => createElement('textarea', { 'aria-label': '代码内容', value, onChange: (event: { target: { value: string } }) => onChange(event.target.value) }) }));
let root: Root; let host: HTMLDivElement; let saved: Entry; let valid: boolean;
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const button = (label: string) => [...host.querySelectorAll('button')].find(element => element.textContent?.trim() === label)!;
async function editor(entry: Entry) {
  function Harness() { const [value, setValue] = useState(entry); saved = value; return <EntryEditor kind="sub" entry={value} sources={[]} busy={false} onChange={setValue} onValidity={value => { valid = value; }} onJsonDraft={() => {}} onSectionChange={() => {}} editorSection="process" />; }
  await act(async () => root.render(<Harness />));
}
it.each([
  [{ type: 'Sort Operator', args: 'asc' }, { customName: 'keep', args: { valuable: 42 } }],
  [null, { type: 'Sort Operator', args: 'asc' }],
  [7], { imported: 'preserve' }, null,
].map(process => [process]))('异常处理器结构保留原文并阻止快捷编辑及保存 %#', async process => {
  const entry = { name: 'A', source: 'local', content: 'synthetic', process } as unknown as Entry;
  await editor(entry);
  await act(async () => button('添加处理器').click());
  expect(saved).toEqual(entry);
  expect(valid).toBe(false);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('完整参数');
  expect([...host.querySelectorAll('.ss-process-panel input, .ss-process-panel textarea, .ss-process-panel button')].every(element => (element as HTMLInputElement).disabled)).toBe(true);
});
it('在完整参数明确修复后恢复添加处理器', async () => {
  await editor({ name: 'A', source: 'local', content: 'synthetic', process: [null] } as unknown as Entry);
  await act(async () => button('完整参数').click());
  const area = host.querySelector('.ss-editor-scroll > .ss-form-panel:last-child textarea') as HTMLTextAreaElement;
  expect(area).toBeTruthy();
  const repaired = { ...saved, process: [{ type: 'Sort Operator', args: 'asc', unknown: 8 }] };
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, JSON.stringify(repaired)); area.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(valid).toBe(true);
  await act(async () => button('处理器').click());
  await act(async () => button('添加处理器').click());
  expect(saved.process).toHaveLength(2); expect(saved.process![0]).toEqual(repaired.process[0]);
});
it('真实引擎改名迁移默认组合引用，回滚后仍能导出并保留同名来源', async () => {
  const engine = await startTestSubStore('.cache/stability-hardening-20261123/integrity');
  try {
    const content = JSON.stringify({ proxies: [{ name: 'sample', type: 'ss', server: '192.0.2.1', port: 443, cipher: 'aes-128-gcm', password: 'synthetic' }] });
    await engine.call('/api/subs', { name: 'C', source: 'local', content, process: [] }, 'POST', 201);
    await engine.call('/api/collections', { name: 'C', subscriptions: ['C'], process: [] }, 'POST', 201);
    for (const [name, extra] of [['legacy', {}], ['profile', { type: 'mihomoProfile' }], ['explicit', { sourceType: 'collection' }], ['source', { sourceType: 'subscription' }]] as const) {
      await engine.call('/api/files', { name, type: 'mihomoConfig', sourceName: 'C', process: [], ...extra }, 'POST', 201);
    }
    for (const [from, to] of [['C', 'D'], ['D', 'C']]) {
      await engine.call(`/api/collection/${from}`, { name: to }, 'PATCH');
      for (const name of ['legacy', 'profile', 'explicit']) {
        expect((await engine.call(`/api/wholeFile/${name}`)).sourceName).toBe(to);
        const response = await engine.http(`/api/file/${name}`); expect(response.status, response.text).toBe(200); expect(response.text).toContain('192.0.2.1');
      }
      expect((await engine.call('/api/wholeFile/source')).sourceName).toBe('C');
    }
  } finally { await engine.close(); }
});
it.each(['subscription', 'collection', undefined])('改名迁移文件添加来源处理器，包括默认来源类型 %s', async sourceType => {
  const engine = await startTestSubStore('.cache/stability-hardening-20261123/integrity');
  try {
    const content = JSON.stringify({ proxies: [{ name: 'sample', type: 'ss', server: '192.0.2.2', port: 443, cipher: 'aes-128-gcm', password: 'synthetic' }] });
    await engine.call('/api/subs', { name: 'A', source: 'local', content, process: [] }, 'POST', 201);
    await engine.call('/api/collections', { name: 'C', subscriptions: ['A'], process: [] }, 'POST', 201);
    const sourceName = sourceType === 'collection' ? 'C' : 'A';
    const process = [{ type: 'Add Proxies From Subscription Operator', args: { sourceName, ...(sourceType === undefined ? {} : { sourceType }), extra: 42 } }];
    await engine.call('/api/files', { name: 'F', type: 'mihomoConfig', sourceType: 'none', process }, 'POST', 201);
    await engine.call(`/api/${sourceType === 'collection' ? 'collection' : 'sub'}/${sourceName}`, { name: 'renamed' }, 'PATCH');
    expect((await engine.call('/api/wholeFile/F')).process[0].args).toEqual({ ...process[0].args, sourceName: 'renamed' });
    const result = await engine.http('/api/file/F'); expect(result.status, result.text).toBe(200); expect(result.text).toContain('192.0.2.2');
  } finally { await engine.close(); }
});
