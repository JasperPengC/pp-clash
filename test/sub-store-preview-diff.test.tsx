// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { PreviewResults } from '../src/components/sub-store/PreviewResults';
import { changedFields, comparePreview } from '../src/components/sub-store/preview-model';

let host: HTMLDivElement; let root: Root;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const node = { id: 0, name: '香港', server: 'hk.invalid', type: 'ss', port: 443 };
const render = async (original: unknown[], processed: unknown[]) => act(async () => root.render(<PreviewResults value={{ original, processed }} />));
const click = async (label: string) => {
  const button = [...host.querySelectorAll('button')].find(item => item.textContent?.trim() === label);
  expect(button, `${label}入口应存在`).toBeTruthy(); await act(async () => button!.click());
};
const expand = async () => act(async () => host.querySelector<HTMLButtonElement>('.ss-preview-node')!.click());

it('排序和字段顺序不制造差异，新增节点与被过滤节点分别统计', () => {
  const before = [{ ...node, extra: { a: 1, b: 2 } }, { ...node, id: 1, name: '删除' }];
  const after = [{ ...node, id: 2, name: '新节点' }, { ...node, extra: { b: 2, a: 1 } }];
  expect(comparePreview(before, after)).toMatchObject({ added: [after[0]], changed: [], removed: [before[1]] });
  expect(changedFields(before[0], after[1])).toEqual([]);
});
it('差异视图逐字段展示改名、值变化、删除和新增，保留false与null含义', async () => {
  await render([{ ...node, udp: true, tls: { sni: 'old.invalid', enabled: true }, obsolete: 0 }], [{ ...node, name: 'HK', udp: false, tls: { enabled: true, sni: 'new.invalid' }, added: null }]);
  await click('差异'); await expand();
  const table = host.querySelector('[aria-label="节点参数差异"]');
  expect(table?.textContent).toContain('处理前'); expect(table?.textContent).toContain('处理后');
  expect(table?.textContent).toContain('old.invalid'); expect(table?.textContent).toContain('new.invalid');
  expect(table?.textContent).toContain('false'); expect(table?.textContent).toContain('null');
  expect(table?.textContent).toContain('未设置'); expect(table?.textContent).toContain('obsolete');
});
it('差异筛选隐藏未变化节点并显示新增和移除标识', async () => {
  await render([node, { ...node, id: 1, name: '移除节点' }], [node, { ...node, id: 2, name: '新增节点' }]);
  await click('差异');
  const text = host.querySelector('.ss-preview-list')?.textContent;
  expect(text).toContain('新增节点'); expect(text).toContain('移除节点'); expect(text).not.toContain('香港');
});
it('可靠身份缺失时禁用差异入口且不伪造新增移除', async () => {
  await render([node], [{ ...node, id: undefined, name: 'HK' }]);
  const button = [...host.querySelectorAll('button')].find(item => item.textContent === '差异');
  expect(button?.disabled).toBe(true); expect(host.textContent).toContain('无法可靠对比');
});
it('只有排序变化时明确显示没有参数差异', async () => {
  const other = { ...node, id: 1, name: '日本' };
  await render([node, other], [other, node]); await click('差异');
  expect(host.textContent).toContain('没有参数差异');
});
