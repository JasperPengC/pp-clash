import { expect, it } from 'vitest';
import { downloadPath, moveProcessor, parseObject, shareRequest, validateEntry } from '../src/components/sub-store/model';

it('完整高级字段和处理器排序启停保持官方未知参数', () => {
  const entry = parseObject('{"name":"source","custom":{"x":1},"process":[{"type":"Script Operator","args":{"custom":"kept"},"disabled":true},{"type":"Regex Filter","args":{"regex":["HK"],"keep":true}}]}');
  expect(moveProcessor(entry.process as never, 0, 1)).toEqual([expect.objectContaining({ type: 'Regex Filter' }), expect.objectContaining({ disabled: true, args: { custom: 'kept' } })]);
  expect(entry.custom).toEqual({ x: 1 });
  expect(() => parseObject('[]')).toThrow('JSON 对象');
});
it('分享提交官方payload/options结构，导出链接编码名称并声明来源类型', () => {
  expect(shareRequest({ name: '组 / 1', type: 'col', token: 'secret', mode: 'count', count: 5, custom: 'kept' })).toEqual({ payload: { custom: 'kept', type: 'col', name: '组 / 1', token: 'secret' }, options: { mode: 'count', count: 5 } });
  expect(downloadPath('collection', '组 / 1', 'ClashMeta')).toBe('/download/collection/%E7%BB%84%20%2F%201?target=ClashMeta');
  expect(downloadPath('file', 'JSON', 'JSON')).toBe('/api/file/JSON?target=JSON');
});
it('无来源的组合及空本地内容不能保存', () => {
  expect(() => validateEntry('collection', { name: '组合', subscriptions: [] })).toThrow('至少一个来源');
  expect(() => validateEntry('sub', { name: '本地', source: 'local', content: '' })).toThrow('本地内容');
});

it('固定分享时间按官方毫秒校验，不接受已过期的时间', () => {
  expect(() => validateEntry('share', { name: 'source', mode: 'datetime', exp: Date.now() - 60_000 })).toThrow('到期时间');
  expect(() => validateEntry('share', { name: 'source', mode: 'datetime', exp: Date.now() + 60_000 })).not.toThrow();
});
it('修改有效时长后重新计算expiresIn，不沿用旧时长', () => {
  expect(shareRequest({ name: 'source', type: 'sub', mode: 'duration', expiresValue: '14', expiresUnit: 'day', expiresIn: '604800s', advanced: { preserve: true } })).toMatchObject({ payload: { advanced: { preserve: true } }, options: { expiresValue: '14', expiresIn: '1209600s' } });
});
it('完整JSON中的小数时长同时规范化expiresValue和expiresIn', () => {
  expect(shareRequest({ name: 'source', type: 'sub', mode: 'duration', expiresValue: '1.111', expiresUnit: 'day' })).toMatchObject({ options: { expiresValue: '1.11', expiresIn: '95904s' } });
  expect(shareRequest({ name: 'source', type: 'sub', mode: 'duration', expiresValue: 1.116, expiresUnit: 'day' })).toMatchObject({ options: { expiresValue: '1.12', expiresIn: '96768s' } });
});
it('时长规范化为零及非有限数时不能提交', () => {
  expect(() => validateEntry('share', { name: 'source', mode: 'duration', expiresValue: '0.001', expiresUnit: 'day' })).toThrow('有效时长');
  expect(() => validateEntry('share', { name: 'source', mode: 'duration', expiresValue: 'Infinity', expiresUnit: 'day' })).toThrow('有效时长');
});
it.each(['mihomoConfig', 'mihomoProfile'])('%s文件按官方sourceType验证，组合和空配置不强制正文', type => {
  for (const sourceType of ['collection', 'subscription', 'none']) {
    expect(() => validateEntry('file', { name: 'F', type, source: 'local', sourceType, sourceName: sourceType === 'none' ? '' : 'C', process: [] })).not.toThrow();
  }
  expect(() => validateEntry('file', { name: 'F', type, source: 'local', sourceType: 'remote', url: 'https://source.test/config' })).not.toThrow();
});
it('Mihomo来源引用及本地远程内容依类型保持必填校验', () => {
  expect(() => validateEntry('file', { name: 'F', type: 'mihomoConfig', sourceType: 'collection', sourceName: '' })).toThrow('来源名称');
  expect(() => validateEntry('file', { name: 'F', type: 'mihomoConfig', sourceType: 'remote', source: 'local', url: '' })).toThrow('远程链接');
  expect(() => validateEntry('file', { name: 'F', type: 'mihomoProfile', sourceType: 'local', source: 'remote', content: '' })).toThrow('本地内容');
});
