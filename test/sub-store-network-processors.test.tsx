// @vitest-environment happy-dom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EntryEditor } from '../src/components/sub-store/EntryEditor';
import { validateEntry, type Entry } from '../src/components/sub-store/model';
import { startTestSubStore } from './helpers/sub-store-engine';
import { startDnsFixture } from './helpers/dns-fixture';
import { writeFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { resolveDomainError } from '../src/components/sub-store/resolver-model';

vi.mock('../src/components/CodeEditor', () => ({ default: ({ value }: { value: string }) => createElement('textarea', { value, readOnly: true }) }));
let host: HTMLDivElement; let root: Root; let saved: Entry; let valid: boolean;
beforeEach(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const click = async (element: Element | null | undefined) => { expect(element, '操作入口应存在').toBeTruthy(); await act(async () => (element as HTMLElement).click()); };
const button = (text: string) => [...host.querySelectorAll('button')].find(value => value.textContent?.trim() === text);
const choose = async (label: string, value: string) => {
  await click(host.querySelector(`[aria-label="${label}"]`));
  const menu = document.querySelector(`[role="listbox"][aria-label="${label}"]`);
  await click([...menu!.querySelectorAll('[role="option"]')].find(element => element.textContent?.trim() === value));
};
const fill = async (label: string, value: string) => act(async () => {
  const element = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!; expect(element).toBeTruthy();
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true }));
});
async function editor(entry: Entry, busy = false) {
  function Harness() { const [value, setValue] = useState(entry); saved = value; return <EntryEditor kind="sub" entry={value} sources={[]} busy={busy} onChange={setValue} onValidity={value => { valid = value; }} onJsonDraft={() => {}} onSectionChange={() => {}} editorSection="process" />; }
  await act(async () => root.render(<Harness />));
}
const entry = (args: Record<string, unknown>, type = 'Resolve Domain Operator'): Entry => ({ name: 'qa-network', source: 'local', content: 'proxies: []', process: [{ type, args, custom: 'kept' }] });
it('快捷参数生成官方协议开关、QUIC和IP版本，并保留高级字段', async () => {
  await editor(entry({ advanced: { preserve: 9 } }, 'Quick Setting Operator'));
  for (const label of ['VMess AEAD', '连接复用', 'ECN']) await choose(label, '启用');
  await choose('阻止 QUIC', '关闭'); await choose('IP 版本', 'IPv6 优先'); await choose('过滤无效信息与端口', '启用');
  expect(saved.process?.[0]).toMatchObject({ custom: 'kept', args: { 'vmess aead': 'ENABLED', reuse: 'ENABLED', ecn: 'ENABLED', 'block-quic': 'off', 'ip-version': 'prefer-v6', useless: 'ENABLED', advanced: { preserve: 9 } } });
});
it('重选快捷参数的未知导入值不改写参数，沿用保持DEFAULT语义', async () => {
  await editor(entry({ reuse: 'future', 'ip-version': 'custom', ecn: 'ENABLED' }, 'Quick Setting Operator'));
  await choose('连接复用', '当前值：future'); await choose('IP 版本', '当前值：custom'); await choose('ECN', '沿用来源');
  expect(saved.process?.[0].args).toEqual({ reuse: 'future', 'ip-version': 'custom', ecn: 'DEFAULT' });
});
it('域名解析可直接添加，默认保留失败节点并复用缓存', async () => {
  await editor({ name: 'S', process: [] }); await choose('新增处理器类型', '域名解析'); await click(button('添加处理器'));
  expect(saved.process?.[0]).toMatchObject({ type: 'Resolve Domain Operator', args: { provider: 'Custom', type: 'IPv4', filter: 'disabled', cache: 'enabled' }, disabled: false });
  expect(valid).toBe(false); await fill('自定义 DNS（每行一个）', 'udp://127.0.0.1:5353'); expect(valid).toBe(true);
});
it('切换解析服务保留自定义地址、IPv6和未知字段；IP-API不支持IPv6时明确阻止', async () => {
  await editor(entry({ provider: 'Custom', type: 'IPv6', url: 'tls://dns.example.invalid', timeout: '1234', custom: 8 }));
  await choose('解析服务', 'IP-API'); expect(valid).toBe(false); expect(host.textContent).toContain('不支持 IPv6');
  await choose('解析服务', '自定义 DNS');
  expect(saved.process?.[0].args).toMatchObject({ type: 'IPv6', url: 'tls://dns.example.invalid', timeout: '1234', custom: 8 }); expect(valid).toBe(true);
});
it.each([
  ['DNS 超时（毫秒）', '0'], ['域名并发数', '1.5'], ['多 DNS 并发数', '-1'], ['缓存时长（秒）', 'wrong'], ['EDNS 地址', 'bad-ip'], ['自定义 DNS（每行一个）', 'file:///etc/hosts'],
])('%s中的错误值%s阻止保存，清空可沿用默认设置', async (label, value) => {
  await editor(entry({ provider: 'Custom', url: 'https://dns.example.invalid/dns-query', type: 'IPv4' }));
  await fill(label, value); expect(valid).toBe(false); expect(() => validateEntry('sub', saved)).toThrow();
  await fill(label, label === '自定义 DNS（每行一个）' ? 'https://dns.example.invalid/dns-query' : ''); expect(valid).toBe(true); expect(() => validateEntry('sub', saved)).not.toThrow();
});
it('关闭未完成解析处理器后可以保存，重新启用仍要求修复', async () => {
  await editor(entry({ provider: 'Custom', url: '' })); expect(valid).toBe(false);
  await click(host.querySelector('[aria-label="启用处理器 1"]')); expect(valid).toBe(true); expect(() => validateEntry('sub', saved)).not.toThrow();
  await click(host.querySelector('[aria-label="启用处理器 1"]')); expect(valid).toBe(false);
});
it('尚未进入处理器页时，导入的错误解析参数仍阻止保存', async () => {
  await act(async () => root.render(<EntryEditor kind="sub" entry={entry({ provider: 'Custom', url: '' })} sources={[]} busy={false} onChange={() => {}} onValidity={value => { valid = value; }} onJsonDraft={() => {}} onSectionChange={() => {}} />));
  expect(valid).toBe(false);
});
it.each([['Custom', { url: '' }], ['IP-API', { type: 'IPv6' }]] as const)('根JSON不能用数组解析服务%s绕过校验', (provider, args) => {
  expect(() => validateEntry('sub', entry({ provider: [provider], ...args }))).toThrow('解析服务');
  const disabled = entry({ provider: [provider], ...args }); disabled.process![0].disabled = true;
  expect(() => validateEntry('sub', disabled)).not.toThrow();
});
it('忙碌时解析地址与快捷参数不能修改', async () => {
  await editor(entry({ provider: 'Custom', url: 'https://dns.example.invalid/dns-query' }), true);
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="自定义 DNS（每行一个）"]')?.disabled).toBe(true);
  expect(host.querySelector<HTMLButtonElement>('[aria-label="解析服务"]')?.disabled).toBe(true);
});
it.each(['udp://127.0.0.1:0', 'tcp://dns.example:65536', 'tls://user:secret@dns.example', 'udp://dns.example/query', 'tcp://dns.example?key=secret', 'tls://dns.example#secret', 'https://', 'file:///etc/hosts'])('拒绝无效DNS地址%s且错误不泄露凭据', url => {
  const error = resolveDomainError({ provider: 'Custom', url }); expect(error).toContain('第 1 行'); expect(error).not.toContain('secret');
});
it.each(['192.0.2.53', '2001:db8::53', '[2001:db8::53]:5353', 'udp://dns.example:5353', 'tcp://[2001:db8::53]:53', 'tls://dns.example', 'https://dns.example/dns-query'])('支持官方解析地址%s并允许空白默认参数', url => {
  expect(resolveDomainError({ provider: 'Custom', url, timeout: ' ', edns: '2001:db8::53' })).toBe('');
});

it('真实表单的DNS解析、失败过滤、缓存与协议参数通过生产引擎保存预览导出', async () => {
  const engine = await startTestSubStore('.cache/network-processors-20261123'); const dns = await startDnsFixture(); const results: unknown[] = [];
  const domainNodes = [
    { name: 'Resolved', type: 'trojan', server: 'resolved.example.invalid', port: 443, password: 'synthetic-only', sni: 'resolved.example.invalid' },
    { name: 'Failed', type: 'ss', server: 'unresolved.example.invalid', port: 443, cipher: 'aes-128-gcm', password: 'synthetic-only' },
    { name: 'Skipped', type: 'ss', server: 'skip.example.invalid', port: 443, cipher: 'aes-128-gcm', password: 'synthetic-only', 'no-resolve': true },
    { name: 'Literal', type: 'ss', server: '192.0.2.10', port: 443, cipher: 'aes-128-gcm', password: 'synthetic-only' },
  ];
  try {
    for (const [url, type, filter, names, address] of [
      [dns.doh, 'IPv4', '保留全部节点', ['Resolved', 'Failed', 'Skipped', 'Literal'], '192.0.2.55'],
      [dns.doh, 'IPv6', '移除解析失败的节点', ['Resolved', 'Skipped', 'Literal'], '2001:db8::55'],
      [dns.udp, 'IPv4', '仅保留 IP 节点', ['Resolved', 'Literal'], '192.0.2.55'],
      [dns.tcp, 'IPv6', '仅保留 IPv6 节点', ['Resolved'], '2001:db8::55'],
      [`${dns.empty}\n${dns.doh}`, 'IPv4', '仅保留 IPv4 节点', ['Resolved', 'Literal'], '192.0.2.55'],
    ] as const) {
      await editor({ name: `qa-resolver-${results.length}`, source: 'local', content: JSON.stringify({ proxies: domainNodes }), process: [] });
      await choose('新增处理器类型', '域名解析'); await click(button('添加处理器')); await fill('自定义 DNS（每行一个）', url);
      await choose('地址类型', type); await choose('解析结果处理', filter); await fill('DNS 超时（毫秒）', '1000'); await fill('域名并发数', '2'); await fill('多 DNS 并发数', '1'); await fill('缓存时长（秒）', '60');
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 170)); });
      const request = structuredClone(saved); const preview = await engine.call('/api/preview/sub', request, 'POST');
      expect(preview.processed.map((node: { name: string }) => node.name)).toEqual(names);
      expect(preview.processed.find((node: { name: string }) => node.name === 'Resolved')).toMatchObject({ server: address, sni: 'resolved.example.invalid', resolved: true });
      await engine.call('/api/subs', request, 'POST', 201); expect(await engine.call(`/api/sub/${request.name}`)).toMatchObject(request);
      const output = await engine.http(`/download/${request.name}?target=ClashMeta`); expect(output.status, output.text).toBe(200);
      expect((load(output.text) as { proxies: unknown[] }).proxies).toEqual(expect.arrayContaining([expect.objectContaining({ server: address, sni: 'resolved.example.invalid' })]));
      const before = dns.requests.filter(query => query.name === 'resolved.example.invalid').length; await engine.call('/api/preview/sub', request, 'POST');
      expect(dns.requests.filter(query => query.name === 'resolved.example.invalid').length).toBe(before);
      await choose('解析缓存', '每次重新解析'); await act(async () => { await new Promise(resolve => setTimeout(resolve, 170)); });
      await engine.call('/api/preview/sub', structuredClone(saved), 'POST');
      expect(dns.requests.filter(query => query.name === 'resolved.example.invalid').length).toBeGreaterThan(before);
      results.push({ request, preview }); writeFileSync(`${engine.data}/${request.name}.yaml`, output.text);
    }
    expect(dns.requests.some(query => query.name === 'skip.example.invalid')).toBe(false);
    const quickNodes = [
      { name: 'SS', type: 'ss', server: '192.0.2.10', port: 443, cipher: 'aes-128-gcm', password: 'synthetic-only', udp: false, ecn: false, aead: false, reuse: false },
      { name: 'VMess', type: 'vmess', server: '192.0.2.20', port: 443, uuid: '00000000-0000-4000-8000-000000000001', aead: false },
      { name: 'AnyTLS', type: 'anytls', server: '192.0.2.30', port: 443, password: 'synthetic-only', reuse: false },
      { name: 'Hysteria2', type: 'hysteria2', server: '192.0.2.40', port: 443, password: 'synthetic-only', ecn: false },
    ];
    await editor({ name: 'qa-protocols', source: 'local', content: JSON.stringify({ proxies: quickNodes }), process: [{ type: 'Quick Setting Operator', args: {} }] });
    for (const label of ['VMess AEAD', '连接复用', 'ECN', 'TCP Fast Open']) await choose(label, '启用');
    await choose('阻止 QUIC', '关闭'); await choose('IP 版本', 'IPv4 优先'); await choose('UDP', '沿用来源');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 170)); });
    const request = structuredClone(saved); const preview = await engine.call('/api/preview/sub', request, 'POST');
    expect(preview.processed.find((node: { name: string }) => node.name === 'SS')).toMatchObject({ udp: false, aead: false, ecn: false, reuse: false, tfo: true, 'block-quic': 'off', 'ip-version': 'prefer-v4' });
    expect(preview.processed.find((node: { name: string }) => node.name === 'VMess').aead).toBe(true);
    expect(preview.processed.find((node: { name: string }) => node.name === 'AnyTLS').reuse).toBe(true);
    expect(preview.processed.find((node: { name: string }) => node.name === 'Hysteria2').ecn).toBe(true);
    await engine.call('/api/subs', request, 'POST', 201); expect(await engine.call(`/api/sub/${request.name}`)).toMatchObject(request);
    const output = await engine.http(`/download/${request.name}?target=JSON`); expect(output.status).toBe(200); expect(JSON.parse(output.text)).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'VMess', aead: true })]));
    results.push({ request, preview }); writeFileSync(`${engine.data}/quick.json`, output.text);
    writeFileSync(`${engine.data}/acceptance.json`, JSON.stringify({ engine: '2.44.16', realUiParameters: true, results, dnsRequests: dns.requests }, null, 2));
  } finally { await dns.close(); await engine.close(); }
}, 30000);
