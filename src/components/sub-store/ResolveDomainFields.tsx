import { object, type Data, type Processor } from './model';
import { ProcessorOption } from './ProcessorOption';
import { resolverNumbers, resolverProviders } from './resolver-model';

export function ResolveDomainFields({ processor, change, busy }: { processor: Processor; change: (value: Processor) => void; busy: boolean }) {
  const args = object(processor.args);
  const update = (patch: Data) => change({ ...processor, args: { ...args, ...patch } });
  const option = (key: string, label: string, fallback: string, options: { value: string; label: string }[]) => <ProcessorOption label={label} value={args[key]} fallback={fallback} options={options} busy={busy} change={value => update({ [key]: value })} />;
  return <>
    <div className="ss-fields">
      {option('provider', '解析服务', '', resolverProviders.map(value => ({ value, label: value === 'Custom' ? '自定义 DNS' : value })))}
      {option('type', '地址类型', 'IPv4', [{ value: 'IPv4', label: 'IPv4' }, { value: 'IPv6', label: 'IPv6' }])}
      {option('filter', '解析结果处理', 'disabled', [{ value: 'disabled', label: '保留全部节点' }, { value: 'removeFailed', label: '移除解析失败的节点' }, { value: 'IPOnly', label: '仅保留 IP 节点' }, { value: 'IPv4Only', label: '仅保留 IPv4 节点' }, { value: 'IPv6Only', label: '仅保留 IPv6 节点' }])}
      {option('cache', '解析缓存', 'enabled', [{ value: 'enabled', label: '复用缓存' }, { value: 'disabled', label: '每次重新解析' }])}
    </div>
    {args.provider === 'Custom' && <label className="ss-field">自定义 DNS（每行一个）<textarea className="input ss-textarea" aria-label="自定义 DNS（每行一个）" value={String(args.url ?? '')} disabled={busy} placeholder={'https://dns.example/dns-query\nudp://127.0.0.1:5353'} onChange={event => update({ url: event.target.value })} /></label>}
    <p className="ss-hint">成功后替换服务器地址，保留原域名用于 TLS。默认保留解析失败的节点；仅保留 IP 会移除跳过解析的域名节点。</p>
    <details className="ss-advanced"><summary>解析高级设置</summary><div className="ss-fields ss-resolver-advanced">
      {resolverNumbers.map(([key, label]) => <label className="ss-field" key={key}>{label}<input className="input" aria-label={label} inputMode="numeric" value={String(args[key] ?? '')} disabled={busy} placeholder="沿用默认设置" onChange={event => update({ [key]: event.target.value })} /></label>)}
      <label className="ss-field">EDNS 地址<input className="input" aria-label="EDNS 地址" value={String(args.edns ?? '')} disabled={busy} placeholder="223.6.6.6" onChange={event => update({ edns: event.target.value })} /></label>
      {args.provider === 'Custom' && option('tlsSkipCertVerify', 'DNS 跳过证书验证', 'disabled', [{ value: 'disabled', label: '验证证书' }, { value: 'enabled', label: '跳过验证' }])}
    </div><p className="ss-hint">域名并发默认 10，多 DNS 并发默认 2。留空沿用引擎默认设置；缓存时长单位为秒。</p></details>
  </>;
}
