// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { PreviewResults } from '../src/components/sub-store/PreviewResults';
import { readSubStoreFailure } from '../src/core/sub-store/failure';
import { requestSubStore } from '../src/core/sub-store/service';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
let host: HTMLDivElement; let root: Root;
const step = { index: 0, type: 'Script Operator', name: '筛选节点', status: 'success', durationMs: 12.5, inputCount: 2, outputCount: 0 };
const trace = { version: 1, chains: [{ scope: { kind: 'sub', name: 'source' }, steps: [step] }], truncated: false };
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = async (value: unknown) => act(async () => root.render(<PreviewResults value={value} />));
const click = async (label: string) => {
  const button = [...host.querySelectorAll('button')].find(item => item.textContent?.trim() === label);
  expect(button, `${label}入口应存在`).toBeTruthy(); await act(async () => button!.click());
};

it('真实预览提供步骤视图，准确保留0节点与毫秒耗时，切回不丢原结果', async () => {
  await render({ original: [{ id: 0, name: '香港' }], processed: [], trace });
  await click('处理步骤');
  expect(host.textContent).toContain('筛选节点'); expect(host.textContent).toContain('来源「source」');
  expect(host.textContent).toContain('2 → 0 个节点'); expect(host.textContent).toContain('12.5 ms');
  expect(host.querySelector('[aria-label="搜索预览节点"]')).toBeNull();
  await click('处理前'); expect(host.textContent).toContain('香港');
});
it('步骤状态与跳过原因分别显示，不给文件处理或未执行步骤编造节点数和耗时', async () => {
  await render({ original: '', processed: 'file content', trace: { ...trace, chains: [{ scope: { kind: 'file', name: 'config' }, steps: [
    { index: 0, type: 'Script Operator', status: 'success', durationMs: 0 },
    { index: 1, type: 'Script Operator', status: 'skipped', skipReason: 'disabled' },
    { index: 2, type: 'Script Operator', status: 'skipped', skipReason: 'context' },
    { index: 3, type: 'Response Transformer', status: 'skipped', skipReason: 'response-transformer' },
    { index: 4, type: 'Script Operator', status: 'failed', durationMs: 2 },
    { index: 5, type: 'Script Operator', status: 'not-run' },
  ] }] } });
  await click('处理步骤');
  const rows = [...host.querySelectorAll('.ss-trace-step')];
  expect(rows).toHaveLength(6); expect(rows[0].textContent).toContain('0 ms');
  expect(rows[1].textContent).toContain('已禁用'); expect(rows[2].textContent).toContain('脚本控制跳过');
  expect(rows[3].textContent).toContain('响应转换不在此阶段执行');
  expect(rows[4].textContent).toContain('失败'); expect(rows[5].textContent).toContain('未执行');
  expect(rows[5].textContent).not.toContain('ms'); expect(host.querySelector('.ss-trace')?.textContent).not.toContain('个节点');
});
it.each(['Sub-Store HTTP 500: ', 'Sub-Store: '])('原生失败通道保留已有轨迹 %s', async prefix => {
  vi.mocked(invoke).mockRejectedValue(prefix + JSON.stringify({ status: 'failed', error: { details: 'bad script', trace } }));
  let error: unknown; try { await requestSubStore('/api/preview/sub', {}); } catch (reason) { error = reason; }
  expect(readSubStoreFailure(error)).toEqual({ message: 'bad script', trace });
});
it.each([
  { ...trace, version: 2 },
  { ...trace, chains: [{ ...trace.chains[0], steps: [{ ...step, durationMs: -1 }] }] },
  { ...trace, chains: [{ ...trace.chains[0], steps: [{ ...step, inputCount: 1.5 }] }] },
  { ...trace, chains: [{ ...trace.chains[0], steps: [{ ...step, index: '0' }] }] },
  { ...trace, chains: [{ ...trace.chains[0], steps: [{ ...step, status: 'invented' }] }] },
  { ...trace, chains: [{ ...trace.chains[0], scope: { kind: 'secret', name: 'source' } }] },
  { ...trace, chains: [{ ...trace.chains[0], steps: [step, step] }] },
])('未知或不可信轨迹不影响节点结果与错误原因 %#', async invalid => {
  await render({ original: [], processed: [{ id: 0, name: '结果节点' }], trace: invalid });
  expect(host.textContent).toContain('结果节点');
  expect([...host.querySelectorAll('button')].some(button => button.textContent === '处理步骤')).toBe(false);
  expect(readSubStoreFailure({ status: 'failed', error: { details: 'bad script', trace: invalid } })).toEqual({ message: 'bad script' });
});
it('过长轨迹明示省略，并只分批渲染当前可见步骤', async () => {
  // 采用紧凑记录覆盖80行渲染边界，实际采集还受总JSON长度限制。
  const steps = Array.from({ length: 90 }, (_, index) => ({ index, type: 'x', status: 'not-run' }));
  await render({ original: [], processed: [], trace: { ...trace, truncated: true, chains: [{ ...trace.chains[0], steps }] } });
  await click('处理步骤'); expect(host.textContent).toContain('部分步骤未展示');
  expect(host.querySelectorAll('.ss-trace-step')).toHaveLength(80);
  await click('显示更多步骤'); expect(host.querySelectorAll('.ss-trace-step')).toHaveLength(90);
});
it('旧响应不增加无用步骤入口，空轨迹也明确说明未记录处理器', async () => {
  await render({ original: [], processed: [] });
  expect([...host.querySelectorAll('button')].some(button => button.textContent === '处理步骤')).toBe(false);
  await render({ original: [], processed: [], trace: { version: 1, chains: [], truncated: false } });
  await click('处理步骤'); expect(host.textContent).toContain('没有已记录的处理步骤');
});
