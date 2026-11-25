import { describe, it, expect, vi, beforeEach } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { requestSubStore, startSubStore } from '../../../src/core/sub-store/service';
describe('native Sub-Store facade', () => {
  beforeEach(() => invoke.mockReset());
  it('unwraps official JSON while retaining processor details', async () => {
    invoke.mockResolvedValueOnce('{"status":"success","data":[{"name":"local","future":true}]}');
    expect(await requestSubStore('/api/subs')).toEqual([{name:'local',future:true}]);
    expect(invoke).toHaveBeenCalledWith('sub_store_request', {request:{path:'/api/subs',method:'GET'}});
    invoke.mockResolvedValueOnce('{"status":"failed","error":{"message":"Processing failed","details":"script exact cause"}}');
    await expect(requestSubStore('/api/preview/sub', {name:'synthetic'})).rejects.toThrow('script exact cause');
  });
  it('returns download text even when it is valid JSON', async () => {
    invoke.mockResolvedValue('{"proxies":[]}');
    expect(await requestSubStore('/download/a?target=JSON')).toBe('{"proxies":[]}');
  });
  it('uses native lifecycle and forwards errors', async () => {
    invoke.mockResolvedValueOnce({phase:'unsupported', version:'2.44.16'});
    expect(await startSubStore()).toEqual({phase:'unsupported',version:'2.44.16'});
    invoke.mockRejectedValueOnce('strict handler reason');
    await expect(requestSubStore('/api/subs')).rejects.toBe('strict handler reason');
  });
});
it('returns GET file JSON as text while wholeFile and PATCH use objects', async () => {
  invoke.mockResolvedValueOnce('{"proxies":[]}');
  expect(await requestSubStore('/api/file/config')).toBe('{"proxies":[]}');
  invoke.mockResolvedValueOnce('{"status":"success","data":{"name":"config"}}');
  expect(await requestSubStore('/api/wholeFile/config')).toEqual({name:'config'});
  invoke.mockResolvedValueOnce('{"status":"success","data":{"name":"config"}}');
  expect(await requestSubStore('/api/file/config', {content:'mode: rule'}, 'PATCH')).toEqual({name:'config'});
});
