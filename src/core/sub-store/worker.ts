import { composeCollection, type CollectionRules } from './compose';
import engineUrl from './vendor/proxy-utils.mjs?url';

// 上游解析器会记录解析失败的原文。仅在短生命周期的后台线程内关闭这些输出。
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) console[level] = () => {};
self.onmessage = async ({ data }: MessageEvent<{ sources: string[]; rules: CollectionRules }>) => {
  try {
    const engine = await import(/* @vite-ignore */ new URL(engineUrl, self.location.href).href);
    const result = composeCollection(data.sources, data.rules, { parse: engine.parse, produce: engine.produce });
    self.postMessage({ raw: result.raw, count: result.nodes.length });
  } catch (error) {
    const text = error instanceof Error ? error.message : '';
    // 只透传应用定义的提示，上游异常可能含有节点地址或凭据。
    const safe = /^(?:请选择 2 至 32 个来源订阅|来源订阅内容过大|第 \d+ 个来源没有可读取的节点|来源节点超过 10000 个|无法生成 Mihomo 节点|替换后的节点名称不能为空|节点依赖未包含的前置代理，请调整筛选条件或来源|筛选后没有可用节点|生成的订阅内容过大)$/.test(text);
    self.postMessage({ error: safe ? text : 'Sub-Store 无法转换来源订阅' });
  }
};
