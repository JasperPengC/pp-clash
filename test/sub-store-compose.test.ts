import { expect, it } from 'vitest';
import { composeCollection } from '../src/core/sub-store/compose';

const recipe = { include: '', exclude: '', find: 'Tokyo', replace: '东京' };
const parser = { parse: (s: string) => s.split(',').filter(Boolean).map(name => ({ name, type: 'http' })), produce: (nodes: unknown[]) => nodes };
it('保留源顺序、过滤名称、字面替换并消除重名', () => {
  const result = composeCollection(['Tokyo-A,London', 'Tokyo-A,Tokyo-B'], { ...recipe, include: 'tokyo', exclude: '-B' }, parser);
  expect(result.nodes.map(n => n.name)).toEqual(['东京-A', '东京-A (2)']);
  expect(result.raw).toContain('MATCH,节点选择');
});
it('每个来源均需解析成功；筛空不产生空配置', () => {
  expect(() => composeCollection(['Tokyo',''], recipe, parser)).toThrow(/来源/);
  expect(() => composeCollection(['Tokyo','London'], {...recipe, include:'不存在'}, parser)).toThrow(/筛选/);
});
