import { Checkbox, Select } from '../ui';
import { object, type Data, type Processor } from './model';
import { QuickSettingsFields } from './QuickSettingsFields';
import { ResolveDomainFields } from './ResolveDomainFields';

const regions = [['HK', '香港'], ['TW', '台湾'], ['US', '美国'], ['SG', '新加坡'], ['JP', '日本'], ['UK', '英国'], ['DE', '德国'], ['KR', '韩国']];
const protocols = ['ss', 'ssr', 'vmess', 'vless', 'trojan', 'http', 'h2-connect', 'socks5', 'snell', 'tuic', 'hysteria', 'hysteria2', 'juicity', 'mieru', 'sudoku', 'masque', 'masque-surge', 'shadowquic', 'naive', 'anytls', 'trusttunnel', 'openvpn', 'gost-relay', 'zerotier', 'tailscale', 'easytier', 'wireguard', 'ssh', 'external', 'direct'].map(value => [value, value]);

export function CommonProcessorFields({ processor, change, busy }: { processor: Processor; change: (value: Processor) => void; busy: boolean }) {
  const args = object(processor.args);
  const update = (patch: Data) => change({ ...processor, args: { ...args, ...patch } });
  if (processor.type === 'Type Filter' || processor.type === 'Region Filter') {
    const values: unknown[] = Array.isArray(processor.args) ? processor.args : Array.isArray(args.value) ? args.value : [];
    const choices = processor.type === 'Region Filter' ? regions : protocols;
    const unknown = values.filter(value => !choices.some(([key]) => key === value));
    const keep = args.keep !== false;
    const updateFilter = (patch: Data) => update({ value: values, keep, ...patch });
    return <>
      <fieldset className="ss-choice-field"><legend>{processor.type === 'Region Filter' ? '选择地区' : '选择协议'}</legend><div className="ss-processor-choices">
        {choices.map(([key, label]) => <Checkbox key={key} ariaLabel={label} disabled={busy} checked={values.includes(key)} onChange={checked => updateFilter({ value: checked ? [...values, key] : values.filter(value => value !== key) })}>{label}</Checkbox>)}
      </div></fieldset>
      <div className="ss-option-row"><span>筛选方式</span><Select ariaLabel="筛选方式" value={keep ? 'keep' : 'exclude'} disabled={busy} options={[{ value: 'keep', label: '保留匹配' }, { value: 'exclude', label: '排除匹配' }]} onChange={value => updateFilter({ keep: value === 'keep' })} /></div>
      {processor.type === 'Region Filter' && <p className="ss-hint">按节点名称识别地区，无法识别的名称不匹配任何地区。</p>}
      {!values.length && <p className="ss-hint">尚未选择{processor.type === 'Region Filter' ? '地区' : '协议'}。{keep ? '保留匹配将得到空结果。' : '当前保留全部节点。'}</p>}
      {!!unknown.length && <p className="ss-hint">已保留高级值：{unknown.map(String).join('、')}。可在完整参数中调整。</p>}
    </>;
  }
  if (processor.type === 'Useless Filter') return <p className="ss-hint">过滤名称中的流量、到期、网址等提示，以及引擎判定无效的字符信息。预览可查看实际被过滤的节点。</p>;
  if (processor.type === 'Flag Operator') return <>
    <div className="ss-option-row"><span>旗标操作</span><Select ariaLabel="旗标操作" value={args.mode === 'remove' ? 'remove' : 'add'} disabled={busy} options={[{ value: 'add', label: '按名称添加旗标' }, { value: 'remove', label: '移除旗标' }]} onChange={mode => update({ mode })} /></div>
    {args.mode !== 'remove' && <div className="ss-option-row"><span>台湾旗标</span><Select ariaLabel="台湾旗标" value={args.tw === 'tw' || args.tw === 'ws' ? args.tw : 'cn'} disabled={busy} options={[{ value: 'tw', label: '使用台湾旗标' }, { value: 'cn', label: '使用中国旗标' }, { value: 'ws', label: '使用替代旗标' }]} onChange={tw => update({ tw })} /></div>}
    <p className="ss-hint">旗标来自节点名称识别，不代表服务器的实际位置。</p>
  </>;
  if (processor.type === 'Handle Duplicate Operator') {
    const field = Array.isArray(args.field) ? args.field : ['name'];
    const identity = JSON.stringify(field) === '["name"]' ? 'name' : JSON.stringify(field) === '["server","port"]' ? 'endpoint' : 'custom';
    return <>
      <div className="ss-option-row"><span>重复判定</span><Select ariaLabel="重复判定" value={identity} disabled={busy} options={[{ value: 'name', label: '节点名称' }, { value: 'endpoint', label: '服务器与端口' }, ...(identity === 'custom' ? [{ value: 'custom', label: '自定义字段（完整参数）' }] : [])]} onChange={value => { if (value !== 'custom') update({ field: value === 'name' ? ['name'] : ['server', 'port'] }); }} /></div>
      <div className="ss-option-row"><span>重复处理</span><Select ariaLabel="重复处理" value={String(args.action ?? 'rename')} disabled={busy} options={[{ value: 'rename', label: '为重复节点编号' }, { value: 'delete', label: '保留首个，删除重复' }]} onChange={action => update({ action })} /></div>
      {args.action !== 'delete' && <>
        <div className="ss-option-row"><span>编号位置</span><Select ariaLabel="编号位置" value={String(args.position ?? 'back')} disabled={busy} options={[{ value: 'back', label: '名称后' }, { value: 'front', label: '名称前' }]} onChange={position => update({ position })} /></div>
        <label className="ss-field">连接符<input className="input" aria-label="编号连接符" disabled={busy} value={String(args.link ?? '-')} onChange={event => update({ link: event.target.value })} /></label>
      </>}
      <p className="ss-hint">服务器与端口相同的节点可能使用不同凭据，删除前请核对预览。完整参数可自定义判定字段和编号模板。</p>
    </>;
  }
  if (processor.type === 'Quick Setting Operator') return <QuickSettingsFields processor={processor} change={change} busy={busy} />;
  if (processor.type === 'Resolve Domain Operator') return <ResolveDomainFields processor={processor} change={change} busy={busy} />;
  return null;
}
