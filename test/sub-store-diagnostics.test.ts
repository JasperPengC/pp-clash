import { beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { requestSubStore } from '../src/core/sub-store/service';
import { readSubStoreFailure } from '../src/core/sub-store/failure';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const processor = { index: 2, type: 'Script Operator', name: '重命名', scope: { kind: 'sub', name: 'source' } };
const envelope = { status: 'failed', error: { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to preview subscription', details: 'Reason: bad expression', processor } };
beforeEach(() => vi.clearAllMocks());

it.each(['Sub-Store HTTP 500: ', 'Sub-Store: '])('原生错误 %s 保留失败位置且使用可读原因', async prefix => {
  vi.mocked(invoke).mockRejectedValue(prefix + JSON.stringify(envelope));
  let reason: unknown;
  try { await requestSubStore('/api/preview/sub', { name: 'source' }); } catch (error) { reason = error; }
  expect(readSubStoreFailure(reason)).toMatchObject({ message: 'Reason: bad expression', processor });
});
it('兼容直接返回的失败信封，不将失败结果当预览数据', async () => {
  vi.mocked(invoke).mockResolvedValue(JSON.stringify(envelope));
  await expect(requestSubStore('/api/preview/sub', {})).rejects.toMatchObject({ message: 'Reason: bad expression', processor });
});
it.each([-1, 1.5, '2', null])('拒绝不可信步骤编号 %s，仍展示原始原因', index => {
  const value = new Error('Sub-Store: ' + JSON.stringify({ ...envelope, error: { ...envelope.error, processor: { ...processor, index } } }));
  expect(readSubStoreFailure(value)).toMatchObject({ message: 'Reason: bad expression' });
  expect(readSubStoreFailure(value).processor).toBeUndefined();
});
it('非结构化错误以及截断信封保留原文而不猜测步骤', () => {
  expect(readSubStoreFailure('Sub-Store 请求失败: 处理超时')).toEqual({ message: 'Sub-Store 请求失败: 处理超时' });
  expect(readSubStoreFailure('Sub-Store HTTP 500: {"status":')).toEqual({ message: 'Sub-Store HTTP 500: {"status":' });
  expect(readSubStoreFailure('Script Operator 2 failed').processor).toBeUndefined();
});
