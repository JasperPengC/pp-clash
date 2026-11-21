import { expect, it, vi } from 'vitest';
import { shareSubscriptionDownload } from '../src/core/subscription-download';

it('同地址同出口共享正在进行的请求，不同出口分开，失败后可立即重试', async () => {
  let fail!: (reason: Error) => void;
  const load = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }))
    .mockResolvedValueOnce('proxy').mockResolvedValueOnce('retry').mockResolvedValueOnce('later');
  const read = shareSubscriptionDownload(load);
  const direct = read('https://local.invalid/feed');
  expect(read('https://local.invalid/feed')).toBe(direct);
  await expect(read('https://local.invalid/feed', 7890)).resolves.toBe('proxy');
  fail(new Error('offline')); await expect(direct).rejects.toThrow('offline');
  await expect(read('https://local.invalid/feed')).resolves.toBe('retry');
  await expect(read('https://local.invalid/feed')).resolves.toBe('later');
  expect(load).toHaveBeenCalledTimes(4);
});
