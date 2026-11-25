import { useEffect, useRef, useState } from 'react';
import { requestSubStore } from '../../core/sub-store/service';
import type { Profile } from '../../domain/app';
import { Dialog } from '../Dialog';
import { Checkbox } from '../ui';
import { entries, entryIdentity, fileUsesEntry, itemPath, object, type Entry, type Tab } from './model';

type Action = 'archive' | 'restore' | 'sync';
interface Confirmation { kind: Tab; items: Entry[]; warnings: string[] }
interface Report { total: number; success: number; failed: { name: string; reason: string }[]; warnings: { name: string; reason: string }[]; pending: number; current: string; running: boolean; stopping: boolean }
interface Options {
  kind: Tab; query: string; items: Entry[]; visible: Entry[]; profiles: Profile[]; busy: boolean;
  run: (label: string, action: () => Promise<void>) => Promise<void>;
  refresh: (kind: Tab) => Promise<void>;
  onArchived: (kind: Tab, entry: Entry) => void;
}
const label = (entry: Entry) => String(entry.displayName || entry.name);
const reasonText = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);


export function useBatchActions(options: Options) {
  const { kind, query, items, visible, profiles, busy, run, refresh, onArchived } = options;
  const scope = JSON.stringify([kind, query]);
  const [selection, setSelection] = useState<{ scope: string; ids: Set<string> }>({ scope, ids: new Set() });
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const alive = useRef(true); const work = useRef<{ stopped: boolean } | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; if (work.current) work.current.stopped = true; }; }, []);
  useEffect(() => { setSelection({ scope, ids: new Set() }); setConfirmation(null); setReport(null); }, [scope]);
  // 服务刷新移除的条目不能在同名条目重新出现后自动恢复为选中。
  useEffect(() => { setSelection(current => ({ ...current, ids: new Set(items.filter(entry => current.ids.has(entryIdentity(kind, entry))).map(entry => entryIdentity(kind, entry))) })); }, [items, kind]);
  const selected = scope === selection.scope ? visible.filter(entry => selection.ids.has(entryIdentity(kind, entry))) : [];
  const isSelected = (entry: Entry) => scope === selection.scope && selection.ids.has(entryIdentity(kind, entry));
  const toggle = (entry: Entry) => {
    if (busy) return;
    setSelection(current => { const ids = new Set(current.scope === scope ? current.ids : []); const id = entryIdentity(kind, entry); if (ids.has(id)) ids.delete(id); else ids.add(id); return { scope, ids }; });
  };
  const toggleAll = () => { if (!busy) setSelection({ scope, ids: new Set(selected.length === visible.length ? [] : visible.map(entry => entryIdentity(kind, entry))) }); };
  const clear = () => { if (!busy) setSelection({ scope, ids: new Set() }); };

  const execute = (action: Action, targetKind: Tab, targets: Entry[]) => run('正在执行批量操作…', async () => {
    if (!targets.length || !alive.current) return;
    setConfirmation(null);
    const control = { stopped: false }; work.current = control;
    let state: Report = { total: targets.length, success: 0, failed: [], warnings: [], pending: targets.length, current: '', running: true, stopping: false };
    const publish = () => { if (alive.current) setReport({ ...state, stopping: control.stopped }); };
    publish();
    try {
      for (const entry of targets) {
        if (control.stopped) break;
        state = { ...state, current: label(entry) }; publish();
        try {
          if (action === 'sync') await requestSubStore(`/api/sync/artifact/${encodeURIComponent(entry.name)}`);
          else if (action === 'restore') await requestSubStore(`/api/archives/${encodeURIComponent(String(entry.id))}/restore`, {}, 'POST');
          else {
            const suffix = targetKind === 'share' ? new URLSearchParams({ type: String(entry.type), name: entry.name, mode: 'archive' }).toString() : 'mode=archive';
            const result = object(await requestSubStore(`${itemPath(targetKind, targetKind === 'share' ? String(entry.token) : entry.name)}?${suffix}`, undefined, 'DELETE'));
            const remote = object(result.remote);
            if (targetKind === 'artifact' && remote.status === 'failed') state = { ...state, warnings: [...state.warnings, { name: label(entry), reason: `本地已归档，远端清理失败：${String(remote.message || '请检查同步平台中的远端文件')}` }] };
            else if (targetKind === 'artifact' && remote.status === 'placeholder_retained') state = { ...state, warnings: [...state.warnings, { name: label(entry), reason: `本地已归档，远端保留占位文件${remote.placeholderFilename ? `：${String(remote.placeholderFilename)}` : ''}` }] };
            onArchived(targetKind, entry);
          }
          state = { ...state, success: state.success + 1 };
          if (alive.current) setSelection(current => { const ids = new Set(current.ids); ids.delete(entryIdentity(targetKind, entry)); return { ...current, ids }; });
        } catch (reason) { state = { ...state, failed: [...state.failed, { name: label(entry), reason: reasonText(reason) }] }; }
        state = { ...state, pending: state.pending - 1 }; publish();
      }
    } finally {
      state = { ...state, running: false, current: '' }; publish(); work.current = null;
    }
    if (alive.current) await refresh(targetKind);
  });
  const prepareArchive = () => run('正在检查批量归档引用…', async () => {
    if (!selected.length) return;
    const warnings: string[] = [];
    if (kind === 'sub' || kind === 'collection' || kind === 'file') {
      const [collections, files, artifacts, shares] = (await Promise.all(['/api/collections', '/api/wholeFiles', '/api/artifacts', '/api/tokens'].map(path => requestSubStore(path)))).map(entries);
      for (const entry of selected) {
        const name = entry.name;
        const append = (title: string, values: { name: string }[]) => { if (values.length) warnings.push(`${label(entry)} · ${title}：${values.map(value => value.name).join('、')}`); };
        append('应用订阅', profiles.filter(profile => profile.subStore?.kind === kind && profile.subStore.name === name));
        if (kind === 'sub') append('组合', collections.filter(value => Array.isArray(value.subscriptions) && value.subscriptions.includes(name)));
        append('文件', files.filter(value => fileUsesEntry(value, kind, name)));
        append('同步', artifacts.filter(value => value.source === name && value.type === (kind === 'sub' ? 'subscription' : kind)));
        append('分享', shares.filter(value => value.name === name && value.type === (kind === 'collection' ? 'col' : kind)));
      }
    }
    if (alive.current) setConfirmation({ kind, items: [...selected], warnings });
  });
  const stop = () => { if (work.current) { work.current.stopped = true; setReport(current => current && { ...current, stopping: true }); } };
  return {
    count: selected.length, total: visible.length, isSelected, toggle, toggleAll, clear,
    prepareArchive, restore: () => execute('restore', kind, [...selected]), sync: () => execute('sync', kind, [...selected]),
    confirmation, dismiss: () => setConfirmation(null), confirm: () => confirmation && execute('archive', confirmation.kind, confirmation.items), report, stop,
  };
}
export type BatchActions = ReturnType<typeof useBatchActions>;

export function BatchToolbar({ batch, kind, busy, onDone }: { batch: BatchActions; kind: Tab; busy: boolean; onDone: () => void }) {
  return <div className="ss-batch-toolbar">
    <Checkbox className="ss-batch-select" ariaLabel="选择当前搜索结果" checked={batch.total > 0 && batch.count === batch.total} indeterminate={batch.count > 0 && batch.count < batch.total} disabled={busy || !batch.total} onChange={batch.toggleAll}>全选</Checkbox>
    <span className="ss-hint">已选 {batch.count} 项</span>
    <div className="ss-batch-buttons">
      {batch.count > 0 && <button className="btn btn-sm btn-ghost" disabled={busy} onClick={batch.clear}>清空选择</button>}
      {kind === 'artifact' && <button className="btn btn-sm" disabled={busy || !batch.count} onClick={() => void batch.sync()}>同步选中</button>}
      <button className="btn btn-sm" disabled={busy || !batch.count} onClick={() => void (kind === 'archive' ? batch.restore() : batch.prepareArchive())}>{kind === 'archive' ? '恢复选中' : '归档选中'}</button>
      <button className="btn btn-sm btn-ghost" disabled={busy} onClick={onDone}>完成</button>
    </div>
  </div>;
}
export function BatchFeedback({ batch }: { batch: BatchActions }) {
  const report = batch.report;
  if (!report) return null;
  return <div className="ss-batch-feedback">
    <div className="ss-batch-progress"><span role="status">{report.running ? report.stopping ? '正在等待当前条目结束' : `正在处理 ${report.total - report.pending + 1}/${report.total} · ${report.current}` : '批量操作已结束'} · 成功 {report.success} · 失败 {report.failed.length} · {report.running ? '待处理' : '未执行'} {report.pending}</span>
      {report.running && <button className="btn btn-sm" disabled={report.stopping} onClick={batch.stop}>停止后续任务</button>}
    </div>
    {report.running && <p className="ss-hint">停止或离页后不再派发下一项，当前条目会执行至结束。</p>}
    {report.failed.length > 0 && <details><summary>查看 {report.failed.length} 项失败详情 · 失败项保持选中，可重试</summary><ul>{report.failed.map((item, index) => <li key={index}><strong>{item.name}</strong>：{item.reason}</li>)}</ul></details>}
    {report.warnings.length > 0 && <details open><summary>{report.warnings.length} 项远端清理提示 · 本地归档已完成</summary><ul>{report.warnings.map((item, index) => <li key={index}><strong>{item.name}</strong>：{item.reason}</li>)}</ul></details>}
  </div>;
}
export function BatchConfirmation({ batch, busy }: { batch: BatchActions; busy: boolean }) {
  const confirmation = batch.confirmation;
  if (!confirmation) return null;
  return <Dialog labelledBy="ss-batch-title" busy={busy} onDismiss={batch.dismiss}>
    <h3 id="ss-batch-title">归档选中的 {confirmation.items.length} 项</h3>
    <p className="modal-desc">归档后可在归档页恢复。{confirmation.kind === 'share' ? '选中分享的令牌将立即失效。' : '已有应用订阅内容保留，关联更新或生成可能受影响。'}</p>
    {confirmation.kind === 'sub' && <p className="ss-hint">来源归档会从组合成员中移除；恢复来源后，需要重新选择组合成员。</p>}
    {confirmation.kind === 'artifact' && confirmation.items.some(entry => entry.url || (entry.updated && entry.upload !== false)) && <p className="ss-error">已上传的同步任务还会尝试删除远端文件；恢复归档不会恢复远端内容，需要重新同步。</p>}
    <div className="ss-batch-confirm-list"><ul>{confirmation.items.map(entry => <li key={entryIdentity(confirmation.kind, entry)}>{label(entry)}</li>)}</ul>
      {confirmation.warnings.length > 0 && <><p className="ss-error">以下关联仍在使用选中条目，请核对后继续：</p><ul>{confirmation.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></>}
    </div>
    <div className="modal-actions"><button className="btn" disabled={busy} onClick={batch.dismiss}>取消</button><button className="btn btn-primary" disabled={busy} onClick={() => void batch.confirm()}>确认归档</button></div>
  </Dialog>;
}
