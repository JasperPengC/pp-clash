import { useEffect, useRef, useState } from 'react';
import CodeEditor from '../CodeEditor';
import { Checkbox, Select, Segmented, Toggle } from '../ui';
import { IconChevronRight, IconPlus, IconX } from '../icons';
import { localDateTime, moveProcessor, normalizeDurationValue, object, parseObject, pretty, type Data, type Entry, type Processor, type Tab, TITLES } from './model';
import { CommonProcessorFields } from './CommonProcessorFields';
import { PROCESSORS } from './processor-catalog';
import { FileSourceFields } from './FileSourceFields';
import { resolveDomainError } from './resolver-model';
import type { SubStoreFailure } from '../../core/sub-store/failure';

export type EditorSection = 'source' | 'process' | 'advanced';
export type JsonDrafts = Record<string, string>;
const jsonError = (text: string) => { try { parseObject(text); return ''; } catch (reason) { return String(reason); } };

export function JsonFields({ value, onChange, busy, onValidity, draftText, onDraftText }: { value: Data; onChange: (value: Data) => void; busy: boolean; onValidity?: (valid: boolean) => void; draftText?: string; onDraftText?: (text: string | undefined) => void }) {
  const [text, setText] = useState(() => draftText ?? pretty(value));
  const [error, setError] = useState(() => draftText === undefined ? '' : jsonError(draftText));
  const canonical = useRef(pretty(value));
  const previousDraftText = useRef(draftText);
  useEffect(() => {
    const next = pretty(value);
    const cleared = previousDraftText.current !== undefined && draftText === undefined;
    previousDraftText.current = draftText;
    if (draftText !== undefined) { setText(draftText); setError(jsonError(draftText)); onValidity?.(false); return; }
    if (cleared || canonical.current !== next) { canonical.current = next; setText(next); setError(''); onValidity?.(true); }
  }, [value, onValidity, draftText]);
  return <div className="ss-code"><CodeEditor value={text} mode="js" disabled={busy} placeholder="JSON 对象" checking={false}
    diagnostics={error ? [{ from: 0, to: Math.max(text.length, 1), line: 1, column: 1, message: error }] : []}
    onChange={next => {
      setText(next);
      try { const parsed = parseObject(next); canonical.current = pretty(parsed); setError(''); onDraftText?.(undefined); onValidity?.(true); onChange(parsed); }
      catch (reason) { setError(String(reason)); onDraftText?.(next); onValidity?.(false); }
    }} /></div>;
}

export function Field({ label, value, onChange, onBlur, busy, type = 'text', step, placeholder }: { label: string; value: unknown; onChange: (value: string) => void; onBlur?: () => void; busy: boolean; type?: string; step?: string; placeholder?: string }) {
  return <label className="ss-field">{label}<input className="input" aria-label={label} type={type} step={step} value={String(value ?? '')} disabled={busy} placeholder={placeholder} onChange={event => onChange(event.target.value)} onBlur={onBlur} /></label>;
}

function ProcessorFields({ processor, change, busy, onValidity, draftText, onDraftText }: { processor: Processor; change: (processor: Processor) => void; busy: boolean; onValidity: (valid: boolean) => void; draftText?: string; onDraftText: (text: string | undefined) => void }) {
  const args = object(processor.args);
  const updateArgs = (patch: Data) => change({ ...processor, args: { ...args, ...patch } });
  const [valid, setValid] = useState(true);
  const formError = processor.type === 'Resolve Domain Operator' ? resolveDomainError(processor.args) : '';
  useEffect(() => { onValidity(valid && (!!processor.disabled || !formError)); }, [valid, processor.disabled, formError, onValidity]);
  return <div className="ss-step-content">
    <Field label="处理器名称" value={processor.customName} busy={busy} onChange={customName => change({ ...processor, customName })} />
    <CommonProcessorFields processor={processor} change={change} busy={busy} />
    {formError && <p role="alert" className="ss-error">{formError}</p>}
    {processor.type === 'Regex Filter' && <>
      <label className="ss-field">匹配表达式（每行一个）<textarea className="input ss-textarea" aria-label="匹配表达式" value={Array.isArray(args.regex) ? args.regex.join('\n') : ''} disabled={busy} onChange={event => updateArgs({ regex: event.target.value.split('\n').filter(Boolean) })} /></label>
      <Select ariaLabel="筛选方式" value={args.keep === false ? 'exclude' : 'keep'} disabled={busy} options={[{ value: 'keep', label: '保留匹配' }, { value: 'exclude', label: '排除匹配' }]} onChange={value => updateArgs({ keep: value === 'keep' })} />
    </>}
    {processor.type === 'Regex Rename Operator' && <div className="ss-rename-rules">{(Array.isArray(processor.args) ? processor.args : []).map((rule, index) => <div className="ss-fields" key={index}>
      <Field label={`匹配 ${index + 1}`} value={object(rule).expr} busy={busy} onChange={expr => change({ ...processor, args: (processor.args as unknown[]).map((value, at) => at === index ? { ...object(value), expr } : value) })} />
      <Field label={`替换 ${index + 1}`} value={object(rule).now} busy={busy} onChange={now => change({ ...processor, args: (processor.args as unknown[]).map((value, at) => at === index ? { ...object(value), now } : value) })} /></div>)}
      <button className="btn btn-sm" disabled={busy} onClick={() => change({ ...processor, args: [...(Array.isArray(processor.args) ? processor.args : []), { expr: '', now: '' }] })}>添加替换规则</button></div>}
    {processor.type === 'Sort Operator' && <Select ariaLabel="名称排序" value={String(processor.args ?? 'asc')} disabled={busy} options={[{ value: 'asc', label: '升序' }, { value: 'desc', label: '降序' }, { value: 'random', label: '随机' }]} onChange={value => change({ ...processor, args: value })} />}
    {processor.type === 'Regex Sort Operator' && <>
      <label className="ss-field">排序表达式（每行一个）<textarea className="input ss-textarea" aria-label="排序表达式（每行一个）" value={Array.isArray(args.expressions) ? args.expressions.join('\n') : ''} disabled={busy} onChange={event => updateArgs({ expressions: event.target.value.split('\n').filter(Boolean) })} /></label>
      <Select ariaLabel="正则排序方式" value={String(args.order ?? 'asc')} disabled={busy} options={[{ value: 'asc', label: '升序' }, { value: 'desc', label: '降序' }, { value: 'original', label: '原顺序' }]} onChange={order => updateArgs({ order })} />
    </>}
    {(processor.type === 'Script Operator' || processor.type === 'Response Transformer') && <>
      <Select ariaLabel="脚本来源" value={String(args.mode ?? 'script')} disabled={busy} options={[{ value: 'script', label: '本地脚本' }, { value: 'link', label: '远程脚本' }]} onChange={mode => updateArgs({ mode })} />
      {args.mode === 'link' ? <Field label="脚本链接" value={args.content} busy={busy} onChange={content => updateArgs({ content })} /> : <div className="ss-code"><CodeEditor value={String(args.content ?? '')} mode="js" disabled={busy} placeholder="编写 Sub-Store 处理脚本" checking={false} diagnostics={[]} onChange={content => updateArgs({ content })} /></div>}
    </>}
    <details className="ss-advanced"><summary>完整处理器参数</summary>
      <p className="ss-hint">保留官方高级参数和自定义处理器字段；修改后参与真实处理。</p>
      <JsonFields value={processor} busy={busy} onChange={value => change(value as Processor)} draftText={draftText} onDraftText={onDraftText} onValidity={setValid} />
      {!valid && <p role="alert" className="ss-error">参数格式错误，修正后才会写入草稿。</p>}
    </details>
  </div>;
}

export function EntryEditor({ kind, entry, sources, collections = [], busy, onChange, onValidity, jsonDrafts = {}, onJsonDraft, editorSection, onSectionChange, failure, focusStep }: { kind: Tab; entry: Entry; sources: Entry[]; collections?: Entry[]; busy: boolean; onChange: (entry: Entry) => void; onValidity: (valid: boolean) => void; jsonDrafts?: JsonDrafts; onJsonDraft: (key: string, text: string | undefined) => void; editorSection?: EditorSection; onSectionChange: (section: EditorSection) => void; failure?: SubStoreFailure; focusStep?: { index: number; request: number } }) {
  const [section, setSection] = useState<EditorSection>(editorSection ?? 'source');
  const [processorType, setProcessorType] = useState(kind === 'file' ? 'Script Operator' : 'Regex Filter');
  const [rawValid, setRawValid] = useState(jsonDrafts.root === undefined);
  const [processorValidity, setProcessorValidity] = useState<Record<number, boolean>>({});
  const editor = useRef<HTMLDivElement>(null);
  useEffect(() => { if (editorSection) setSection(editorSection); }, [editorSection]);
  useEffect(() => {
    if (!focusStep || section !== 'process') return;
    const step = editor.current?.querySelector<HTMLElement>(`[data-processor-index="${focusStep.index}"]`);
    step?.scrollIntoView({ block: 'nearest' }); step?.focus({ preventScroll: true });
  }, [focusStep, section]);
  const patch = (value: Data) => onChange({ ...entry, ...value });
  const normalizeDuration = () => {
    const expiresValue = normalizeDurationValue(entry.expiresValue);
    if (expiresValue !== String(entry.expiresValue ?? '')) patch({ expiresValue, expiresIn: undefined });
  };
  const processValid = entry.process === undefined || (Array.isArray(entry.process) && entry.process.every(item => item && typeof item === 'object' && !Array.isArray(item) && typeof item.type === 'string'));
  const process = processValid && Array.isArray(entry.process) ? entry.process : [];
  useEffect(() => { onValidity(processValid && !Object.keys(jsonDrafts).length && rawValid && process.every((_, index) => processorValidity[index] !== false)); }, [rawValid, processValid, process, processorValidity, onValidity, jsonDrafts]);
  const changeProcessor = (index: number, processor: Processor) => patch({ process: process.map((value, at) => at === index ? processor : value) });
  const updateProcessors = (next: Processor[], reindex: (index: number) => number | null) => {
    patch({ process: next });
    const buffers = Object.entries(jsonDrafts).filter(([key]) => key.startsWith('process:'));
    for (const [key] of buffers) onJsonDraft(key, undefined);
    for (const [key, text] of buffers) {
      const index = reindex(Number(key.slice(8)));
      if (index !== null) onJsonDraft(`process:${index}`, text);
    }
    setProcessorValidity({});
  };
  const replaceEntry = (value: Data) => {
    if (pretty(value.process) !== pretty(entry.process)) {
      for (const key of Object.keys(jsonDrafts)) if (key.startsWith('process:')) onJsonDraft(key, undefined);
      setProcessorValidity({});
    }
    onChange(value as Entry);
  };
  const isContent = kind === 'sub' || kind === 'collection' || kind === 'file';
  return <div className="ss-editor" ref={editor}>
    <Segmented ariaLabel="编辑内容" options={[{ value: 'source', label: isContent ? '来源与内容' : `${TITLES[kind]}设置` }, ...(isContent ? [{ value: 'process' as const, label: '处理器' }] : []), { value: 'advanced', label: '完整参数' }]} value={section} onChange={value => { setSection(value); onSectionChange(value); }} disabled={busy} />
    <div className="ss-editor-scroll">
      <div hidden={section !== 'source'} className="ss-form-panel">
        <div className="ss-fields"><Field label={kind === 'share' ? '分享对象名称' : '名称'} value={entry.name} busy={busy} onChange={name => patch({ name })} />
          <Field label="显示名称" value={entry.displayName} busy={busy} onChange={displayName => patch({ displayName })} /></div>
        <Field label="备注" value={entry.remark} busy={busy} onChange={remark => patch({ remark })} />
        {kind === 'file' && <FileSourceFields entry={entry} sources={sources} collections={collections} busy={busy} onChange={onChange} />}
        {kind === 'sub' && <>
          <div className="ss-source-heading"><strong>内容来源</strong><Segmented ariaLabel="内容来源" value={entry.source === 'local' ? 'local' : 'remote'} options={[{ value: 'remote', label: '远程链接' }, { value: 'local', label: '本地内容' }]} onChange={source => patch({ source })} disabled={busy} /></div>
          {entry.source === 'local' ? <div className="ss-code ss-source-code"><CodeEditor value={String(entry.content ?? '')} mode="yaml" disabled={busy} placeholder="粘贴订阅或文件内容" checking={false} diagnostics={[]} onChange={content => patch({ content })} /></div> : <label className="ss-field">远程链接（每行一个）<textarea className="input ss-textarea" aria-label="远程链接" value={String(entry.url ?? '')} disabled={busy} onChange={event => patch({ url: event.target.value })} /></label>}
          <div className="ss-fields"><Field label="User-Agent" value={entry.ua} busy={busy} onChange={ua => patch({ ua })} /><Field label="流量信息" value={entry.subUserinfo} busy={busy} onChange={subUserinfo => patch({ subUserinfo })} /></div>
          <div className="ss-inline"><span>跳过缓存</span><Toggle on={entry.noCache === true} label="跳过缓存" disabled={busy} onChange={noCache => patch({ noCache })} /></div>
        </>}
        {kind === 'collection' && <><p className="ss-hint">勾选要合并的来源，按勾选顺序处理。</p>
          <div className="ss-source-choices">{sources.map(source => <Checkbox key={source.name} disabled={busy} checked={Array.isArray(entry.subscriptions) && entry.subscriptions.includes(source.name)} onChange={checked => {
            const current = Array.isArray(entry.subscriptions) ? entry.subscriptions : [];
            patch({ subscriptions: checked ? [...current, source.name] : current.filter(value => value !== source.name) });
          }}>{String(source.displayName ?? source.name)}</Checkbox>)}{!sources.length && <p className="ss-hint">尚无来源，请先添加来源。</p>}</div></>}
        {kind === 'artifact' && <>
          <div className="ss-fields"><label className="ss-field">同步类型<Select ariaLabel="同步类型" value={String(entry.type ?? 'subscription')} disabled={busy} options={[{ value: 'subscription', label: '来源' }, { value: 'collection', label: '组合' }, { value: 'file', label: '文件' }]} onChange={type => patch({ type, source: '' })} /></label>
            <label className="ss-field">输出格式<Select ariaLabel="输出格式" value={String(entry.platform ?? 'ClashMeta')} disabled={busy} options={['ClashMeta', 'Clash', 'Surge', 'SurgeMac', 'QX', 'Loon', 'Surfboard', 'Stash', 'ShadowRocket', 'Egern', 'sing-box', 'V2Ray', 'URI', 'JSON'].map(value => ({ value, label: value }))} onChange={platform => patch({ platform })} /></label></div>
          <Field label="同步来源名称" value={entry.source} busy={busy} onChange={source => patch({ source })} />
          <Field label="定时表达式" value={entry.cron} busy={busy} onChange={cron => patch({ cron })} />
          <div className="ss-inline"><span>自动同步</span><Toggle on={entry.sync === true} label="自动同步" disabled={busy} onChange={sync => patch({ sync })} /><span>上传到云端</span><Toggle on={entry.upload === true} label="上传到云端" disabled={busy} onChange={upload => patch({ upload })} /></div>
          <p className="ss-hint">保存任务后可手动同步。云端凭据在本页“后端设置”中配置。</p>
        </>}
        {kind === 'share' && <>
          <div className="ss-fields"><label className="ss-field">对象类型<Select ariaLabel="分享对象类型" value={String(entry.type ?? 'sub')} disabled={busy} options={[{ value: 'sub', label: '来源' }, { value: 'col', label: '组合' }, { value: 'file', label: '文件' }]} onChange={type => patch({ type })} /></label><Field label="分享令牌（留空自动生成）" value={entry.token} busy={busy} onChange={token => patch({ token })} /></div>
          <label className="ss-field">有效期<Select ariaLabel="有效期模式" value={String(entry.mode ?? 'duration')} disabled={busy} options={[{ value: 'duration', label: '时长' }, { value: 'datetime', label: '固定时间' }, { value: 'count', label: '次数' }]} onChange={mode => patch({ mode })} /></label>
          {entry.mode === 'count' ? <Field label="最多访问次数" value={entry.count} type="number" busy={busy} onChange={value => patch({ count: Number(value) })} /> : entry.mode === 'datetime' ? <Field label="到期时间" value={localDateTime(entry.exp)} type="datetime-local" busy={busy} onChange={value => patch({ exp: value ? new Date(value).getTime() : null })} /> : <div className="ss-fields"><Field label="有效时长" value={entry.expiresValue} type="number" step="0.01" busy={busy} onChange={expiresValue => patch({ expiresValue, expiresIn: undefined })} onBlur={normalizeDuration} /><label className="ss-field">单位<Select ariaLabel="有效期单位" value={String(entry.expiresUnit ?? 'day')} disabled={busy} options={[{ value: 'day', label: '天' }, { value: 'month', label: '月' }, { value: 'season', label: '季度' }, { value: 'year', label: '年' }, { value: 'lifetime', label: '永久' }]} onChange={expiresUnit => patch({ expiresUnit, expiresIn: undefined })} /></label></div>}
          <p className="ss-hint">保存会创建或更新令牌；撤销后该分享立即失效。</p>
        </>}
      </div>
      {isContent && <div hidden={section !== 'process'} className="ss-process-panel">
        {!processValid && <p role="alert" className="ss-error">处理器结构异常，原始内容已保留。请在“完整参数”中修复 process 后再编辑或保存。</p>}
        <div className="ss-source-heading"><Select ariaLabel="新增处理器类型" value={processorType} disabled={busy || !processValid} options={PROCESSORS.filter(item => kind !== 'file' || ['Script Operator', 'Response Transformer'].includes(item.type)).map(item => ({ value: item.type, label: item.label }))} onChange={setProcessorType} /><button className="btn" disabled={busy || !processValid} onClick={() => { const selected = PROCESSORS.find(item => item.type === processorType)!; patch({ process: [...process, { type: selected.type, args: structuredClone(selected.args), disabled: false }] }); }}><IconPlus size={14} />添加处理器</button></div>
        {process.map((processor, index) => <section className="ss-step" key={index} tabIndex={-1} data-processor-index={index} data-processor-failed={failure?.processor?.index === index || undefined} data-disabled={processor.disabled === true}><header><span className="ss-step-index">{index + 1}</span><h3>{String(processor.customName || PROCESSORS.find(item => item.type === processor.type)?.label || processor.type)}</h3>
          <button className="icon-btn ss-up" aria-label={`上移处理器 ${index + 1}`} disabled={busy || index === 0} onClick={() => updateProcessors(moveProcessor(process, index, -1), at => at === index ? index - 1 : at === index - 1 ? index : at)}><IconChevronRight size={14} /></button>
          <button className="icon-btn ss-down" aria-label={`下移处理器 ${index + 1}`} disabled={busy || index === process.length - 1} onClick={() => updateProcessors(moveProcessor(process, index, 1), at => at === index ? index + 1 : at === index + 1 ? index : at)}><IconChevronRight size={14} /></button>
          <Toggle on={!processor.disabled} label={`启用处理器 ${index + 1}`} disabled={busy || !processValid} onChange={enabled => changeProcessor(index, { ...processor, disabled: !enabled })} />
          <button className="icon-btn" aria-label={`移除处理器 ${index + 1}`} disabled={busy || !processValid} onClick={() => updateProcessors(process.filter((_, at) => at !== index), at => at === index ? null : at > index ? at - 1 : at)}><IconX size={14} /></button></header>
          {failure?.processor?.index === index && <p className="ss-error">本次预览失败：{failure.message}</p>}
          <ProcessorFields processor={processor} busy={busy} change={value => changeProcessor(index, value)} draftText={jsonDrafts[`process:${index}`]} onDraftText={text => onJsonDraft(`process:${index}`, text)} onValidity={value => setProcessorValidity(current => current[index] === value ? current : { ...current, [index]: value })} /></section>)}
        {processValid && !process.length && <p className="ss-hint">尚未添加处理器，将保留来源内容。可用完整参数加入其他官方处理器。</p>}
      </div>}
      <div hidden={section !== 'advanced'} className="ss-form-panel"><p className="ss-hint">编辑完整 JSON，未列出的字段会保留。</p><JsonFields value={entry} onChange={replaceEntry} busy={busy} onValidity={setRawValid} draftText={jsonDrafts.root} onDraftText={text => onJsonDraft('root', text)} /></div>
    </div>
  </div>;
}
