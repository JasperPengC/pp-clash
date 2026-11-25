import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EmptyState, SearchField, Segmented } from '../ui';
import { IconChevronRight } from '../icons';
import { VirtualList } from '../VirtualList';
import { object, pretty, type Data } from './model';
import { comparePreview, matchesPreviewNode } from './preview-model';
import { readProcessorTrace } from '../../core/sub-store/trace';
import { ProcessorTraceResults } from './ProcessorTraceResults';
import { PreviewText } from './PreviewText';
import { useApp } from '../../store/app';

type View = 'processed' | 'original' | 'filtered' | 'diff' | 'trace';
type Comparison = ReturnType<typeof comparePreview>;
const fieldValue = (node: Data, key: string) => Object.hasOwn(node, key) ? pretty(node[key]) : '未设置';
const nameOf = (node: Data) => String(node.name ?? '未命名节点');
const addressOf = (node: Data) => `${String(node.server ?? '服务器未知')}${node.port != null ? `:${node.port}` : ''}`;

function NodeDetails({ value, previous, fields, onBack }: { value: unknown; previous?: Data; fields: string[]; onBack: () => void }) {
  const back = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => back.current?.focus(), []);
  const node = object(value);
  return <section className="ss-preview-detail" aria-label="节点详情">
    <button ref={back} className="btn btn-sm" onClick={onBack}><IconChevronRight className="ss-back" size={12} />返回节点列表</button>
    <h4>{nameOf(node)}</h4><p>{addressOf(node)} · {String(node.type ?? '未知类型')}</p>
    {previous && fields.length > 0 && <table className="ss-field-diff" aria-label="节点参数差异"><thead><tr><th>字段</th><th>处理前</th><th>处理后</th></tr></thead><tbody>
      {fields.map(key => <tr key={key}><th scope="row">{key}</th><td><PreviewText compact label={`${key}处理前`} value={fieldValue(previous, key)} /></td><td><PreviewText compact label={`${key}处理后`} value={fieldValue(node, key)} /></td></tr>)}
    </tbody></table>}
    <PreviewText value={value} label="节点完整参数" />
  </section>;
}

function NodeResults({ rows, comparison, view, query, total }: { rows: unknown[]; comparison: Comparison; view: View; query: string; total: number }) {
  const textSize = useApp(state => state.settings.textSize);
  const rowHeight = textSize === 'large' ? 104 : textSize === 'larger' ? 100 : 96;
  const [selection, setSelection] = useState<number | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const returnIndex = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (selection === null && returnIndex.current !== null) {
      const button = container.current?.querySelector<HTMLButtonElement>(`[data-preview-index="${returnIndex.current}"]`);
      (button ?? container.current?.querySelector<HTMLElement>('[role="list"]'))?.focus({ preventScroll: true });
      returnIndex.current = null;
    }
  }, [selection]);
  const previousFor = (value: unknown) => view === 'processed' || view === 'diff' ? comparison?.before.get(object(value).id) : undefined;
  const fieldsFor = (value: unknown) => view === 'processed' || view === 'diff' ? comparison?.fields.get(object(value).id) ?? [] : [];
  return <div ref={container}>
    <div hidden={selection !== null}>
      {rows.length ? <VirtualList className="ss-preview-list" label="预览节点列表" items={rows} rowHeight={rowHeight} maxHeight={360} itemKey={(_item, index) => index}
        renderItem={(item, index) => {
          const node = object(item); const previous = previousFor(item); const fields = fieldsFor(item).filter(key => key !== 'name');
          const renamed = previous && previous.name !== node.name ? `${String(previous.name ?? '')} → ${nameOf(node)}` : '';
          const change = view !== 'diff' ? '' : !comparison?.after.has(node.id) ? '被过滤节点' : !comparison.before.has(node.id) ? '新增节点' : '参数已变更';
          return <button className="ss-preview-node" data-preview-index={index} aria-label={`查看节点 ${nameOf(node)} 详情`} onClick={() => { returnIndex.current = index; setSelection(index); }}>
            <IconChevronRight size={12} /><span className="ss-preview-node-copy"><span title={nameOf(node)}>{nameOf(node)}</span>
              {renamed && <small title={renamed}>{renamed}</small>}
              {!!fields.length && <small title={`参数变更：${fields.join('、')}`}>参数变更：{fields.join('、')}</small>}
              <small title={addressOf(node)}>{addressOf(node)}</small>
            </span><span className="ss-preview-type"><small>{String(node.type ?? '未知类型')}</small>{change && <small>{change}</small>}</span>
          </button>;
        }} /> : <div className="ss-preview-list"><EmptyState compact title={total ? '没有匹配的节点' : view === 'filtered' ? '没有被过滤的节点' : view === 'diff' ? '没有参数差异' : '没有节点'} desc={total ? '调整或清空搜索条件后重试。' : view === 'filtered' ? '处理后保留了全部原始节点。' : view === 'diff' ? '节点参数保持一致；仅排序变化不计入差异。' : '当前来源或处理器没有生成节点。'} /></div>}
      {!!rows.length && <div className="ss-preview-pagination"><span>共 {rows.length}{query.trim() ? ' 个匹配节点' : ' 个节点'}</span><span>滚动浏览 · 点击查看详情</span></div>}
    </div>
    {selection !== null && <NodeDetails value={rows[selection]} previous={previousFor(rows[selection])} fields={fieldsFor(rows[selection])} onBack={() => setSelection(null)} />}
  </div>;
}

function PreviewContent({ value }: { value: unknown }) {
  const [view, setView] = useState<View>('processed');
  const [query, setQuery] = useState('');
  const [rawOpen, setRawOpen] = useState(false);
  const data = object(value);
  const trace = useMemo(() => readProcessorTrace(data.trace), [data.trace]);
  const isNodes = Array.isArray(data.original) && Array.isArray(data.processed);
  const comparison = useMemo(() => isNodes ? comparePreview(data.original as unknown[], data.processed as unknown[]) : null, [data.original, data.processed, isNodes]);
  const selected = useMemo(() => view === 'filtered' ? comparison?.removed : view === 'diff' ? comparison && [...comparison.changed, ...comparison.added, ...comparison.removed] : data[view], [view, comparison, data.original, data.processed]);
  const rows = useMemo(() => Array.isArray(selected) ? query.trim() ? selected.filter(node => matchesPreviewNode(node, query, comparison?.before.get(object(node).id))) : selected : [], [selected, query, comparison]);
  return <div className="ss-preview">
    <div className="ss-preview-heading"><Segmented value={view} onChange={setView} ariaLabel="预览阶段" options={[{ value: 'processed', label: '处理后' }, { value: 'original', label: '处理前' }, ...(isNodes ? [{ value: 'filtered' as const, label: '被过滤', disabled: !comparison }, { value: 'diff' as const, label: '差异', disabled: !comparison }] : []), ...(trace ? [{ value: 'trace' as const, label: '处理步骤' }] : [])]} />
      {isNodes && <span>处理前 {(data.original as unknown[]).length} 个节点 · 处理后 {(data.processed as unknown[]).length} 个节点{comparison && ` · 被过滤 ${comparison.removed.length} · 新增 ${comparison.added.length} · 变更 ${comparison.changed.length}`}</span>}</div>
    {isNodes && view !== 'trace' && <><SearchField ariaLabel="搜索预览节点" placeholder="搜索名称、服务器或协议" value={query} onChange={setQuery} />
      {!comparison && <p className="ss-hint">节点身份缺失或重复，无法可靠对比被过滤节点与参数变化。仍可查看处理前后结果。</p>}</>}
    {view === 'trace' && trace ? <ProcessorTraceResults trace={trace} /> : Array.isArray(selected)
      ? <NodeResults key={`${view}:${query}`} rows={rows} total={selected.length} view={view} query={query} comparison={comparison} />
      : <PreviewText key={view} value={typeof selected === 'string' ? selected : value} label={view === 'original' ? '处理前文本' : '处理后文本'} />}
    <details className="ss-preview-raw" onToggle={event => setRawOpen(event.currentTarget.open)}><summary>完整预览数据</summary>{rawOpen && <PreviewText value={value} label="完整预览数据" />}</details>
  </div>;
}

export function PreviewResults({ value }: { value: unknown }) {
  // 一个新响应拥有新的浏览状态，避免旧窗口/详情泄漏到替换后的数据。
  const [source, setSource] = useState({ value, revision: 0 });
  if (source.value !== value) setSource({ value, revision: source.revision + 1 });
  return <PreviewContent key={source.revision} value={value} />;
}
