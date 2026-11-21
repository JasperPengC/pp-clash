import type { CollectionRules } from './compose';
export type CollectionResult = { raw: string; count: number };
export function processCollection(sources: string[], rules: CollectionRules): Promise<CollectionResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const finish = () => { clearTimeout(timer); worker.terminate(); };
    const timer = setTimeout(() => { finish(); reject(new Error('处理订阅超时')); }, 30000);
    worker.onerror = () => { finish(); reject(new Error('无法启动 Sub-Store 处理器')); };
    worker.onmessage = ({ data }) => {
      finish();
      if (typeof data?.raw === 'string' && Number.isSafeInteger(data.count) && data.count > 0) resolve(data);
      else reject(new Error(typeof data?.error === 'string' ? data.error : '处理订阅失败'));
    };
    try { worker.postMessage({ sources, rules }); } catch (error) { finish(); reject(error); }
  });
}
