import { object, type Processor } from './model';
import { ProcessorOption } from './ProcessorOption';

const tristate = [{ value: 'DEFAULT', label: '沿用来源' }, { value: 'ENABLED', label: '启用' }, { value: 'DISABLED', label: '关闭' }];
const fields = [['udp', 'UDP'], ['tfo', 'TCP Fast Open'], ['scert', '跳过证书验证'], ['vmess aead', 'VMess AEAD'], ['reuse', '连接复用'], ['ecn', 'ECN'], ['useless', '过滤无效信息与端口']];

export function QuickSettingsFields({ processor, change, busy }: { processor: Processor; change: (value: Processor) => void; busy: boolean }) {
  const args = object(processor.args);
  const update = (key: string, value: string) => change({ ...processor, args: { ...args, [key]: value } });
  return <>
    <div className="ss-fields">{fields.map(([key, label]) => <ProcessorOption key={key} label={label} value={args[key]} fallback="DEFAULT" options={tristate} busy={busy} change={value => update(key, value)} />)}
      <ProcessorOption label="阻止 QUIC" value={args['block-quic']} fallback="DEFAULT" options={[{ value: 'DEFAULT', label: '沿用来源' }, { value: 'auto', label: '自动' }, { value: 'on', label: '启用' }, { value: 'off', label: '关闭' }]} busy={busy} change={value => update('block-quic', value)} />
      <ProcessorOption label="IP 版本" value={args['ip-version']} fallback="DEFAULT" options={[{ value: 'DEFAULT', label: '沿用来源' }, { value: 'dual', label: 'IPv4 / IPv6' }, { value: 'v4-only', label: '仅 IPv4' }, { value: 'v6-only', label: '仅 IPv6' }, { value: 'prefer-v4', label: 'IPv4 优先' }, { value: 'prefer-v6', label: 'IPv6 优先' }]} busy={busy} change={value => update('ip-version', value)} />
    </div>
    <p className="ss-hint">沿用来源保持节点原值。AEAD 仅用于 VMess；连接复用用于 Snell、AnyTLS、TrustTunnel；ECN 用于 TUIC、Hysteria2。</p>
  </>;
}
