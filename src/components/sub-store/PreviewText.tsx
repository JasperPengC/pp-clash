import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { pretty } from './model';

const CHUNK_SIZE = 16000;
// 分段边界保持UTF-16代理对完整，复制始终由弹窗读取完整数据。
function boundary(text: string, index: number) {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff && text.charCodeAt(index - 1) >= 0xd800 && text.charCodeAt(index - 1) <= 0xdbff ? index - 1 : index;
}

/** 只在打开文本时序列化，DOM中始终仅保留一段。 */
export function PreviewText({ value, label, compact = false }: { value: unknown; label: string; compact?: boolean }) {
  const text = useMemo(() => typeof value === 'string' ? value : pretty(value) ?? '', [value]);
  const [page, setPage] = useState(0);
  const count = Math.max(1, Math.ceil(text.length / CHUNK_SIZE));
  const current = Math.min(page, count - 1);
  const content = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => { if (content.current) { content.current.scrollTop = 0; content.current.scrollLeft = 0; } }, [current, text]);
  const part = text.slice(boundary(text, current * CHUNK_SIZE), boundary(text, (current + 1) * CHUNK_SIZE));
  return <div className="ss-preview-text" role="group" aria-label={label}>
    {count > 1 && <div className="ss-preview-text-nav"><span>第 <input className="input" type="number" min={1} max={count} aria-label={`${label}段落`} value={current + 1}
      onChange={event => { const next = event.currentTarget.valueAsNumber; if (Number.isInteger(next) && next >= 1 && next <= count) setPage(next - 1); }} /> / {count} 段</span>
      <div><button className="btn btn-sm" disabled={current === 0} onClick={() => setPage(current - 1)}>上一段</button><button className="btn btn-sm" disabled={current === count - 1} onClick={() => setPage(current + 1)}>下一段</button></div>
      <small>分段阅读；“复制内容”包含完整预览数据。</small></div>}
    {compact ? <code>{part}</code> : <pre ref={content}>{part}</pre>}
  </div>;
}
