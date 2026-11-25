import CodeEditor from '../CodeEditor';
import { Select, Toggle } from '../ui';
import { isMihomoFile, type Data, type Entry } from './model';

const sourceTypes = [
  { value: 'subscription', label: '已有来源' }, { value: 'collection', label: '已有组合' },
  { value: 'remote', label: '远程链接' }, { value: 'local', label: '本地内容' }, { value: 'none', label: '空配置' },
];
const basicConfig = 'mode: rule\nproxy-groups:\n  - name: PROXY\n    type: select\n    include-all: true\n    proxies: [DIRECT]\nrules:\n  - MATCH,PROXY\n';

export function FileSourceFields({ entry, sources, collections, busy, onChange }: { entry: Entry; sources: Entry[]; collections: Entry[]; busy: boolean; onChange: (entry: Entry) => void }) {
  const patch = (value: Data) => onChange({ ...entry, ...value });
  const mihomo = isMihomoFile(entry);
  const fileType = mihomo ? 'mihomoConfig' : String(entry.type || 'file');
  const sourceType = mihomo ? sourceTypes.some(item => item.value === entry.sourceType) ? String(entry.sourceType) : 'collection' : entry.source === 'local' ? 'local' : 'remote';
  const linked = mihomo && (sourceType === 'subscription' || sourceType === 'collection');
  const inputSource = sourceType === 'local' || sourceType === 'remote';
  const nodeMode = linked || (mihomo && inputSource && entry.mode === 'proxy');
  const choices = sourceType === 'collection' ? collections : sources;
  const sourceName = String(entry.sourceName ?? '');
  const missing = linked && !!sourceName && !choices.some(item => item.name === sourceName);
  const inputMode = String(entry.mode || 'config');
  const modes = [{ value: 'config', label: '完整配置' }, { value: 'proxy', label: '仅提取节点' }];
  return <>
    <div className="ss-fields">
    <label className="ss-field">文件类型<Select ariaLabel="文件类型" value={fileType} disabled={busy}
      options={[{ value: 'file', label: '普通文本文件' }, { value: 'mihomoConfig', label: 'Mihomo 配置' }, ...(!['file', 'mihomoConfig'].includes(fileType) ? [{ value: fileType, label: `当前类型：${fileType}` }] : [])]}
      onChange={type => {
        if (type === fileType) return;
        if (type === 'mihomoConfig') {
          const initial = entry.source === 'local' && String(entry.content ?? '').trim() ? 'local' : entry.source === 'remote' && String(entry.url ?? '').trim() ? 'remote' : 'subscription';
          patch({ type, ...(!sourceTypes.some(item => item.value === entry.sourceType) ? { sourceType: initial } : {}) });
        } else patch({ type });
      }} /></label>
    <label className="ss-field">{mihomo ? 'Mihomo 内容来源' : '内容来源'}<Select ariaLabel={mihomo ? 'Mihomo 内容来源' : '内容来源'} value={sourceType} disabled={busy}
      options={mihomo ? sourceTypes : sourceTypes.filter(item => ['remote', 'local'].includes(item.value))}
      onChange={value => {
        if (value === sourceType) return;
        patch(mihomo ? { sourceType: value, ...(['subscription', 'collection'].includes(value) ? { sourceName: '' } : {}) } : { source: value });
      }} /></label>
    </div>
    {linked && <>
      <label className="ss-field">{sourceType === 'collection' ? '选择组合' : '选择来源'}<Select ariaLabel={sourceType === 'collection' ? '选择组合' : '选择来源'} value={sourceName} disabled={busy}
        options={[{ value: '', label: sourceType === 'collection' ? '请选择组合' : '请选择来源' }, ...(missing ? [{ value: sourceName, label: `${sourceName}（已不存在）` }] : []), ...choices.map(item => ({ value: item.name, label: String(item.displayName || item.name) }))]}
        onChange={name => patch({ sourceName: name })} /></label>
      {missing ? <p role="alert" className="ss-error">引用的{sourceType === 'collection' ? '组合' : '来源'} {sourceName} 已不存在，请重新选择后预览或保存。</p> : <p className="ss-hint">{choices.length ? '使用所选条目处理后的节点。生成的节点列表可在处理器中补充分组与规则。' : `尚无${sourceType === 'collection' ? '组合' : '来源'}，请先创建或改用本地内容。`}</p>}
    </>}
    {mihomo && inputSource && <>
      <label className="ss-field">内容用途<Select ariaLabel="内容用途" value={inputMode} disabled={busy}
        options={[...modes, ...(!modes.some(item => item.value === inputMode) ? [{ value: inputMode, label: `当前模式：${inputMode}` }] : [])]} onChange={mode => patch({ mode })} /></label>
      <p className="ss-hint">{entry.mode === 'proxy' ? '只提取节点，端口、规则等配置不会保留。可在处理器中添加配置模板。' : '按完整 Mihomo 配置读取，保留正文中的分组、规则和其他配置。'}</p>
    </>}
    {inputSource && <>
      {sourceType === 'local' ? <div className="ss-code ss-source-code"><CodeEditor value={String(entry.content ?? '')} mode="yaml" disabled={busy} placeholder={mihomo && entry.mode !== 'proxy' ? '粘贴完整 Mihomo 配置' : '粘贴文件或节点内容'} checking={false} diagnostics={[]} onChange={content => patch({ content })} /></div>
        : <label className="ss-field">远程链接（每行一个）<textarea className="input ss-textarea" aria-label="远程链接" value={String(entry.url ?? '')} disabled={busy} onChange={event => patch({ url: event.target.value })} /></label>}
      <div className="ss-fields"><label className="ss-field">User-Agent<input className="input" aria-label="User-Agent" value={String(entry.ua ?? '')} disabled={busy} onChange={event => patch({ ua: event.target.value })} /></label><label className="ss-field">流量信息<input className="input" aria-label="流量信息" value={String(entry.subUserinfo ?? '')} disabled={busy} onChange={event => patch({ subUserinfo: event.target.value })} /></label></div>
      <div className="ss-option-row"><span>跳过缓存</span><Toggle on={entry.noCache === true} label="跳过缓存" disabled={busy} onChange={noCache => patch({ noCache })} /></div>
    </>}
    {nodeMode && <div className="ss-option-row"><span>保留不受支持的协议</span><Toggle on={entry.includeUnsupportedProxy === true} label="保留不受支持的协议" disabled={busy} onChange={includeUnsupportedProxy => patch({ includeUnsupportedProxy })} /></div>}
    {mihomo && (nodeMode || sourceType === 'none') && <div className="ss-source-heading ss-file-template"><p className="ss-hint">{sourceType === 'none' ? '从空配置开始，由处理器构建内容。' : '基础模板添加 PROXY 选择分组与默认规则；可在处理器中编辑或移除。'}</p><button className="btn btn-sm" disabled={busy || (entry.process != null && !Array.isArray(entry.process))} onClick={() => patch({ process: [...(entry.process ?? []), { type: 'Script Operator', customName: '基础配置模板', args: { mode: 'script', content: basicConfig }, disabled: false }] })}>添加基础配置模板</button></div>}
  </>;
}
