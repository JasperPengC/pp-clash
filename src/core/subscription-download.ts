/** 组合与来源同时刷新时可共享网络读取；出口不同的数据不得混用。 */
export function shareSubscriptionDownload<T>(load: (url: string, proxyPort?: number) => Promise<T>) {
  const pending = new Map<string, Promise<T>>();
  return (url: string, proxyPort?: number) => {
    const key = JSON.stringify([url, proxyPort ?? null]);
    const existing = pending.get(key);
    if (existing) return existing;
    const request = Promise.resolve().then(() => load(url, proxyPort)).finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  };
}
