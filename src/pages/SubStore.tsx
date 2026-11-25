import { useEffect, useRef, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { api, isTauri } from '../core/api';
import { getSubStoreStatus, requestSubStore, startSubStore, stopSubStore, type SubStoreStatus } from '../core/sub-store/service';
import { useApp } from '../store/app';
import { usePageQuery, useViewPreference } from '../store/view-preferences';
import { Dialog } from '../components/Dialog';
import { Checkbox, EmptyState, Pill, ReadError, SearchField, Segmented, Select } from '../components/ui';
import { IconChevronRight, IconPlus, IconRefresh, IconSettings, IconX } from '../components/icons';
import { EntryEditor, type EditorSection, type JsonDrafts } from '../components/sub-store/EntryEditor';
import { BatchConfirmation, BatchFeedback, BatchToolbar, useBatchActions } from '../components/sub-store/BatchActions';
import { BackendSettingsDialog } from '../components/sub-store/BackendSettingsDialog';
import { PreviewResults } from '../components/sub-store/PreviewResults';
import { ProcessorFailureNotice } from '../components/sub-store/ProcessorFailureNotice';
import { ProcessorTraceResults } from '../components/sub-store/ProcessorTraceResults';
import type { ProcessorTrace } from '../core/sub-store/trace';
import { readSubStoreFailure, type SubStoreFailure } from '../core/sub-store/failure';
import { PREVIEW_CANCELLED, SubStorePreview } from '../core/sub-store/preview';
import { createEntry, downloadPath, entries, entryIdentity, fileUsesEntry, itemPath, isMihomoFile, LIST_PATH, mihomoFileSourceLabel, object, pretty, shareRequest, TITLES, validateEntry, type Data, type Entry, type Kind, type Tab } from '../components/sub-store/model';
import '../components/sub-store/sub-store.css';

interface Draft { kind: Tab; original: string | null; identity: string | null; entry: Entry; baseline: string; invalidated?: string; serviceName?: string; jsonDrafts?: JsonDrafts; section?: EditorSection }
const drafts = new Map<string, Draft>();
const draftKey = (kind: Tab, name: string | null) => `${kind}:${name ?? '@new'}`;
const emptyLists: Record<Tab, Entry[]> = { sub: [], collection: [], file: [], artifact: [], share: [], archive: [] };
const outputTargets = ['ClashMeta', 'Clash', 'Surge', 'SurgeMac', 'QX', 'Loon', 'Stash', 'ShadowRocket', 'Egern', 'sing-box', 'V2Ray', 'URI', 'JSON'];
const errorMessage = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
const PRIVATE_SHARE_HINT = '暂不支持外部订阅链接。此处管理本机访问令牌。';

export function SubStorePage() {
  const [tab, setTab] = useViewPreference('subStoreTab'); const [query, setQuery] = usePageQuery('sub-store');
  const [status, setStatus] = useState<SubStoreStatus | null>(null); const [lists, setLists] = useState(emptyLists);
  const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [readError, setReadError] = useState(''); const [message, setMessage] = useState('');
  const [batchMode, setBatchMode] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null); const [valid, setValid] = useState(true); const [deleting, setDeleting] = useState<Entry | null>(null);
  const [failure, setFailure] = useState<SubStoreFailure | undefined>();
  const [focusStep, setFocusStep] = useState<{ index: number; request: number }>();
  const draftRef = useRef(draft); draftRef.current = draft;
  const [result, setResult] = useState<{ title: string; text: string; exportable: boolean; preview?: unknown; trace?: ProcessorTrace; traceError?: string } | null>(null);
  const [target, setTarget] = useState('ClashMeta'); const [backendSettings, setBackendSettings] = useState<Data | null>(null); const [settingsBaseline, setSettingsBaseline] = useState(''); const [settingsValid, setSettingsValid] = useState(true);
  const lock = useRef(false); const alive = useRef(true);
  const previewTask = useRef<SubStorePreview | null>(null);
  const [previewPhase, setPreviewPhase] = useState<'running' | 'cancelling' | ''>('');
  const exportTask = useRef<SubStorePreview | null>(null);
  const [exportPhase, setExportPhase] = useState<'running' | 'cancelling' | ''>('');
  const importTask = useRef<SubStorePreview | null>(null);
  const [importPhase, setImportPhase] = useState<'running' | 'cancelling' | ''>('');
  const profiles = useApp(state => state.profiles);
  const dirty = !!draft && (pretty(draft.entry) !== draft.baseline || !!Object.keys(draft.jsonDrafts ?? {}).length);
  const linked = (kind: Tab, name: string) => profiles.filter(profile => profile.subStore?.kind === kind && profile.subStore.name === name);
  const currentLists = lists[tab].filter(entry => `${entry.name} ${entry.displayName ?? ''} ${entry.remark ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  async function run(label: string, action: () => Promise<void>, preserveFailure = false) {
    if (lock.current) return; lock.current = true; setBusy(label); setError(''); setMessage(''); if (!preserveFailure) { setFailure(undefined); setFocusStep(undefined); }
    try { await action(); } catch (reason) { if (alive.current) setError(errorMessage(reason)); }
    finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  async function refresh(kind = tab) {
    try { const data = await requestSubStore(kind === 'file' ? '/api/wholeFiles' : LIST_PATH[kind]); if (alive.current) { setLists(current => ({ ...current, [kind]: entries(data) })); setReadError(''); } }
    catch (reason) { if (alive.current) setReadError(errorMessage(reason)); throw reason; }
  }
  useEffect(() => {
    alive.current = true;
    void run('正在检查后端…', async () => { setStatus(await getSubStoreStatus()); });
    return () => { alive.current = false; void previewTask.current?.cancel().catch(() => {}); void exportTask.current?.cancel().catch(() => {}); };
  }, []);
  useEffect(() => { if (status?.phase === 'running') void run('正在读取列表…', () => refresh(tab)); }, [tab, status?.phase]);
  const remember = (next: Draft) => {
    if (draftRef.current && (next.kind !== draftRef.current.kind || pretty(next.entry) !== pretty(draftRef.current.entry) || pretty(next.jsonDrafts) !== pretty(draftRef.current.jsonDrafts))) {
      setFailure(undefined); setFocusStep(undefined); setError('');
    }
    const key = draftKey(next.kind, next.identity);
    if (pretty(next.entry) !== next.baseline || Object.keys(next.jsonDrafts ?? {}).length) drafts.set(key, next); else drafts.delete(key);
    draftRef.current = next;
    setDraft(next);
  };
  const updateJsonDraft = (key: string, text: string | undefined) => {
    const current = draftRef.current; if (!current) return;
    const jsonDrafts = { ...current.jsonDrafts };
    if (text === undefined) delete jsonDrafts[key]; else jsonDrafts[key] = text;
    remember({ ...current, jsonDrafts });
  };
  function invalidateRelated(kind: Tab, oldName: string, identity: string | null) {
    for (const [key, candidate] of drafts) {
      const usesSource = kind === 'sub' && candidate.kind === 'collection' && Array.isArray(candidate.entry.subscriptions) && candidate.entry.subscriptions.includes(oldName);
      const usesArtifact = candidate.kind === 'artifact' && candidate.entry.source === oldName && candidate.entry.type === (kind === 'sub' ? 'subscription' : kind);
      const usesFile = candidate.kind === 'file' && (fileUsesEntry(candidate.entry, kind, oldName, true)
        || (candidate.entry.sourceName === oldName && candidate.entry.sourceType === (kind === 'sub' ? 'subscription' : kind)));
      const usesShare = candidate.kind === 'share' && candidate.entry.name === oldName && candidate.entry.type === (kind === 'collection' ? 'col' : kind);
      if (key === draftKey(kind, identity) || usesSource || usesArtifact || usesFile || usesShare) drafts.set(key, { ...candidate, invalidated: '关联来源已变更。未保存的草稿仍保留，请核对最新内容后再保存。' });
    }
  }
  async function canonicalEntry(kind: Tab, value: Entry): Promise<Entry> {
    if (kind === 'share') {
      const canonical = entries(await requestSubStore('/api/tokens')).find(item => entryIdentity(kind, item) === entryIdentity(kind, value));
      if (!canonical) throw new Error('分享已不存在，请刷新列表后重试。');
      return canonical;
    }
    const canonical = object(await requestSubStore(kind === 'file' ? `/api/wholeFile/${encodeURIComponent(value.name)}` : itemPath(kind, value.name)));
    if (typeof canonical.name !== 'string' || !canonical.name) throw new Error('服务没有返回完整条目，请刷新列表后重试。');
    return canonical as Entry;
  }
  async function openEditor(entry: Entry | null) {
    if (tab === 'archive') return;
    const original = entry ? tab === 'share' ? String(entry.token) : entry.name : null;
    const identity = entry ? entryIdentity(tab, entry) : null;
    const remembered = drafts.get(draftKey(tab, identity));
    await run('正在读取完整内容…', async () => {
      const kind = tab;
      if (kind === 'file') { await refresh('sub'); await refresh('collection'); }
      if (remembered) { setValid(!Object.keys(remembered.jsonDrafts ?? {}).length); setDraft(remembered); return; }
      const value = !entry ? createEntry(kind) : await canonicalEntry(kind, entry);
      if (kind === 'collection') await refresh('sub');
      const next = { kind, original: entry ? kind === 'share' ? String(value.token) : value.name : original, identity: entry ? entryIdentity(kind, value) : identity, entry: value, baseline: pretty(value) }; remember(next); setValid(true);
    });
  }
  const persist = () => draft && run('正在保存草稿…', async () => {
    validateEntry(draft.kind, draft.entry, { sources: lists.sub, collections: lists.collection });
    if (!valid || draft.invalidated) throw new Error(draft.invalidated || '请先修正完整参数中的 JSON 错误');
    if (draft.kind !== 'share' && (draft.serviceName || draft.original) !== draft.entry.name && lists[draft.kind].some(entry => entry.name === draft.entry.name)) throw new Error('已有同名条目，请使用其他名称');
    const kind = draft.kind;
    let savedEntry = draft.entry;
    if (kind === 'share') {
      const previous = object(JSON.parse(draft.baseline));
      const creating = draft.original && draft.entry.token === draft.original ? { ...draft.entry, token: '' } : draft.entry;
      const saved = object(await requestSubStore('/api/token', shareRequest(creating), 'POST'));
      if (saved.token) savedEntry = { ...draft.entry, token: saved.token };
      if (draft.original) {
        drafts.delete(draftKey(kind, draft.identity));
        remember({ ...draft, entry: savedEntry, original: String(savedEntry.token), identity: entryIdentity(kind, savedEntry), baseline: pretty(savedEntry) });
        try { await requestSubStore(`${itemPath('share', draft.original)}?${new URLSearchParams({ type: String(previous.type), name: String(previous.name), mode: 'archive' })}`, undefined, 'DELETE'); }
        catch (reason) { await refresh(kind); throw new Error(`新分享已创建，旧分享撤销失败，两个令牌都有效。请在列表单独撤销旧分享。${errorMessage(reason)}`); }
      }
    }
    else {
      savedEntry = { ...draft.entry, ...object(await requestSubStore(draft.original ? itemPath(kind, draft.serviceName || draft.original) : LIST_PATH[kind], draft.entry, draft.original ? 'PATCH' : 'POST')) } as Entry;
      if (draft.original && draft.original !== savedEntry.name && (kind === 'sub' || kind === 'collection')) {
        try { await useApp.getState().renameSubStoreReferences({ kind, oldName: draft.original, newName: savedEntry.name }); }
        catch (reason) {
          try { await requestSubStore(itemPath(kind, savedEntry.name), { ...savedEntry, name: draft.original }, 'PATCH'); }
          catch (rollback) {
            remember({ ...draft, serviceName: savedEntry.name });
            throw new Error(`应用引用更新失败：${errorMessage(reason)}。服务名称回滚也失败：${errorMessage(rollback)}。服务当前名称为 ${savedEntry.name}，草稿已保留，可重试保存以完成引用迁移。`);
          }
          remember({ ...draft, serviceName: undefined });
          throw new Error(`应用引用更新失败：${errorMessage(reason)}。服务名称已回滚，草稿仍保留。`);
        }
      }
    }
    drafts.delete(draftKey(kind, draft.identity));
    if (draft.original && draft.original !== savedEntry.name && kind !== 'share') invalidateRelated(kind, draft.original, draft.identity);
    const next = { ...draft, entry: savedEntry, original: kind === 'share' ? String(savedEntry.token) : savedEntry.name, identity: entryIdentity(kind, savedEntry), baseline: pretty(savedEntry), invalidated: undefined, serviceName: undefined }; remember(next);
    setMessage(kind === 'share' ? '分享令牌已保存' : kind === 'file' ? '草稿已保存。文件可预览或导出。' : '草稿已保存。加入应用后才会成为应用订阅。');
    await refresh(kind);
    try { const canonical = await canonicalEntry(kind, savedEntry); remember({ ...next, original: kind === 'share' ? String(canonical.token) : canonical.name, identity: entryIdentity(kind, canonical), entry: canonical, baseline: pretty(canonical) }); }
    catch (reason) { throw new Error(`保存已完成，但重新读取失败：${errorMessage(reason)}。返回列表后可重试读取。`); }
  });
  const reloadDraft = () => draft && run('正在读取最新内容…', async () => {
    const lookup = draft.kind === 'share' ? object(JSON.parse(draft.baseline)) as Entry : { ...draft.entry, name: draft.serviceName || draft.original || draft.entry.name };
    const value = await canonicalEntry(draft.kind, lookup);
    if (draft.kind === 'collection') await refresh('sub');
    if (draft.kind === 'file') { await refresh('sub'); await refresh('collection'); }
    drafts.delete(draftKey(draft.kind, draft.identity));
    remember({ ...draft, original: draft.kind === 'share' ? String(value.token) : value.name, identity: entryIdentity(draft.kind, value), entry: value, baseline: pretty(value), invalidated: undefined, serviceName: undefined, jsonDrafts: {} });
  });
  const preview = () => draft && run('正在生成预览…', async () => {
    validateEntry(draft.kind, draft.entry, { sources: lists.sub, collections: lists.collection });
    const task = new SubStorePreview(); previewTask.current = task; setPreviewPhase('running');
    try {
      const value = await requestSubStore(`/api/preview/${draft.kind}`, draft.entry, 'POST', task);
      if (!alive.current || previewTask.current !== task) return;
      if (task.cancelled) { setMessage('预览已结束，结果已忽略，草稿已保留'); return; }
      setResult({ title: '真实处理预览', text: '', exportable: false, preview: value });
    }
    catch (reason) {
      if (!alive.current || previewTask.current !== task) return;
      if (errorMessage(reason) === PREVIEW_CANCELLED) { setError(''); setMessage('预览已取消，草稿已保留'); return; }
      if (task.cancelled) { setError(errorMessage(reason)); return; }
      const failure = readSubStoreFailure(reason); setFailure(failure); if (failure.processor || failure.trace) return;
      throw reason;
    }
    finally { if (previewTask.current === task) { previewTask.current = null; if (alive.current) setPreviewPhase(''); } }
  });
  const cancelPreview = async () => {
    const task = previewTask.current; if (!task || previewPhase === 'cancelling') return;
    setPreviewPhase('cancelling'); setBusy('正在停止预览…'); setError('');
    try { await task.cancel(); }
    catch (reason) { if (alive.current && previewTask.current === task) { setError(`取消未确认：${errorMessage(reason)}。可重试取消。`); setPreviewPhase('running'); setBusy('正在生成预览…'); } }
  };
  const showFailureTrace = failure?.trace ? () => setResult({ title: '处理步骤', text: pretty({ error: failure.message, trace: failure.trace }), exportable: false, trace: failure.trace, traceError: failure.message }) : undefined;
  const failedStep = failure?.processor;
  const isCurrentFailure = !!draft && failedStep?.scope.kind === draft.kind && failedStep.scope.name === draft.entry.name;
  const canLocate = isCurrentFailure && Array.isArray(draft?.entry.process) && draft.entry.process[failedStep!.index]?.type === failedStep!.type &&
    draft.entry.process.every(item => item && typeof item.type === 'string');
  const failureAction = canLocate ? '定位处理器' : failedStep && !isCurrentFailure ? `打开出错${TITLES[failedStep.scope.kind]}` : undefined;
  const locateFailure = async () => {
    if (!draft || !failedStep) return;
    if (canLocate) {
      remember({ ...draft, section: 'process' }); setFocusStep(current => ({ index: failedStep.index, request: (current?.request ?? 0) + 1 })); return;
    }
    if (!failureAction) return;
    const recordedFailure = failure;
    await run('正在读取出错内容…', async () => {
      const kind = failedStep.scope.kind;
      const canonical = await canonicalEntry(kind, { name: failedStep.scope.name });
      const identity = entryIdentity(kind, canonical);
      const remembered = drafts.get(draftKey(kind, identity));
      const next: Draft = remembered ?? { kind, original: canonical.name, identity, entry: canonical, baseline: pretty(canonical) };
      if (kind === 'collection' || kind === 'file') await refresh('sub');
      if (kind === 'file') await refresh('collection');
      setTab(kind); remember({ ...next, section: 'process' }); setValid(!Object.keys(next.jsonDrafts ?? {}).length);
      // 已存在的来源草稿可能与产生错误的已保存内容不同，不把旧位置强加给新内容。
      if (!Object.keys(next.jsonDrafts ?? {}).length && !next.invalidated && pretty(next.entry) === pretty(canonical) && Array.isArray(next.entry.process) && next.entry.process[failedStep.index]?.type === failedStep.type) {
        setFailure(recordedFailure); setFocusStep({ index: failedStep.index, request: Date.now() });
      } else setMessage('已打开草稿。内容已有修改，请重新预览以定位当前错误。');
    });
  };
  const generate = (kind: Kind, name: string, add = false) => run(add ? '正在生成并加入应用…' : '正在生成导出…', async () => {
    const task = new SubStorePreview();
    const taskRef = add ? importTask : exportTask;
    const setPhase = add ? setImportPhase : setExportPhase;
    taskRef.current = task; setPhase('running');
    try {
      const path = downloadPath(kind, name, add ? 'ClashMeta' : target);
      const raw = await requestSubStore<unknown>(path, undefined, 'GET', task);
      // 加入应用沿用离页后继续导入；导出结果仅交付给发起页面。
      if (!add && (!alive.current || exportTask.current !== task)) return;
      if (task.cancelled) { if (alive.current) setMessage(add ? '生成已取消，未加入应用订阅' : '导出已结束，结果已忽略'); return; }
      if (typeof raw !== 'string' || !raw.trim()) throw new Error('后端没有返回可用的订阅内容');
      if (add) {
        if (kind === 'file') throw new Error('文件不能作为 Sub-Store 订阅加入应用');
        // 从此进入完整的校验与持久化事务，不再取消生成。
        importTask.current = null;
        if (alive.current) { setImportPhase(''); setBusy('正在校验并保存订阅…'); }
        await useApp.getState().addSubStoreProfile(String(lists[kind].find(entry => entry.name === name)?.displayName || name), { kind, name }, raw);
        if (alive.current) setMessage('已加入应用订阅');
      } else setResult({ title: `${name} · ${target}`, text: raw, exportable: true });
    } catch (reason) {
      if (!add && (!alive.current || exportTask.current !== task)) return;
      if (errorMessage(reason) === PREVIEW_CANCELLED) {
        if (alive.current) { setError(''); setMessage(add ? '生成已取消，未加入应用订阅' : '导出已取消，已保存内容和草稿均保留'); }
        return;
      }
      throw reason;
    } finally { if (taskRef.current === task) { taskRef.current = null; if (alive.current) setPhase(''); } }
  });
  const cancelImport = async () => {
    const task = importTask.current; if (!task || importPhase === 'cancelling') return;
    setImportPhase('cancelling'); setBusy('正在停止生成…'); setError('');
    try { await task.cancel(); }
    catch (reason) { if (alive.current && importTask.current === task) { setError(`取消未确认：${errorMessage(reason)}。可重试取消。`); setImportPhase('running'); setBusy('正在生成并加入应用…'); } }
  };
  const cancelExport = async () => {
    const task = exportTask.current; if (!task || exportPhase === 'cancelling') return;
    setExportPhase('cancelling'); setBusy('正在停止导出…'); setError('');
    try { await task.cancel(); }
    catch (reason) { if (alive.current && exportTask.current === task) { setError(`取消未确认：${errorMessage(reason)}。可重试取消。`); setExportPhase('running'); setBusy('正在生成导出…'); } }
  };
  async function exportText(text: string, title: string) {
    if (isTauri) { const path = await save({ defaultPath: `${title.replace(/[^\w\u4e00-\u9fff.-]/g, '_')}.yaml`, filters: [{ name: '文本文件', extensions: ['yaml', 'txt', 'json'] }] }); if (!path) return; await api.exportLogFile(path, text); }
    else { const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'sub-store-export.yaml'; anchor.click(); URL.revokeObjectURL(url); }
    setMessage('文件已导出');
  }
  const remove = (archive: boolean) => deleting && run(archive ? '正在归档…' : '正在删除…', async () => {
    const name = tab === 'share' ? String(deleting.token) : tab === 'archive' ? String(deleting.id) : deleting.name;
    const suffix = tab === 'share' ? `?${new URLSearchParams({ type: String(deleting.type), name: deleting.name, mode: archive ? 'archive' : 'permanent' })}` : tab === 'archive' ? '' : `?mode=${archive ? 'archive' : 'permanent'}`;
    await requestSubStore(itemPath(tab, name) + suffix, undefined, 'DELETE'); setDeleting(null); invalidateRelated(tab, deleting.name, entryIdentity(tab, deleting)); await refresh(); setMessage(archive ? '已归档，可在归档中恢复' : tab === 'share' ? '分享已撤销' : '已删除');
  });
  const dependentCollections = deleting && tab === 'sub' ? lists.collection.filter(entry => Array.isArray(entry.subscriptions) && entry.subscriptions.includes(deleting.name)) : [];
  const applicationLinks = deleting ? linked(tab, deleting.name) : [];
  const batch = useBatchActions({ kind: tab, query, items: lists[tab], visible: currentLists, profiles, busy: !!busy, run, refresh, onArchived: (kind, entry) => invalidateRelated(kind, entry.name, entryIdentity(kind, entry)) });
  const closeBatch = () => { batch.clear(); setBatchMode(false); };
  const contentKind = tab === 'sub' || tab === 'collection' || tab === 'file';
  return <div className="sub-store-page">
    <header className="page-head"><div className="page-heading"><h1 className="page-title">Sub-Store</h1><div className="page-sub ss-runtime">{status ? <><Pill tone={status.phase === 'running' ? 'ok' : status.phase === 'failed' ? 'bad' : 'neutral'}>{status.phase === 'running' ? '后端运行中' : status.phase === 'unsupported' ? '此平台暂不支持' : status.phase === 'starting' ? '正在启动' : status.phase === 'failed' ? '启动失败' : '后端已停止'}</Pill>{status.version && <span>{status.version}</span>}</> : '正在检查后端'}</div></div>
      <div className="page-actions"><button className="icon-btn" aria-label="后端设置" disabled={!!busy || status?.phase !== 'running'} onClick={() => void run('正在读取后端设置…', async () => { const settings = object(await requestSubStore('/api/settings')); setBackendSettings(settings); setSettingsBaseline(pretty(settings)); })}><IconSettings size={16} /></button>
        <button className="btn" disabled={!!busy || status?.phase === 'unsupported'} onClick={() => void run(status?.phase === 'running' ? '正在停止后端…' : '正在启动后端…', async () => { if (status?.phase === 'running') { await stopSubStore(); setStatus(await getSubStoreStatus()); } else setStatus(await startSubStore()); })}>{status?.phase === 'running' ? '停止后端' : '启动后端'}</button></div></header>
    {status?.phase !== 'running' ? <div className="page-scroll"><EmptyState compact loading={!status || !!busy} title={status?.phase === 'unsupported' ? '此平台暂不支持完整 Sub-Store' : '启动后端后管理来源与组合'} desc={status?.error || '本机处理订阅、文件与脚本，生成结果可加入应用。'} />{error && <ReadError message={error} onRetry={() => void run('正在检查后端…', async () => setStatus(await getSubStoreStatus()))} />}</div>
    : <div className="ss-native">
      {draft ? <><div className="ss-editor-heading"><div><button className="icon-btn ss-back" aria-label="返回列表" disabled={!!busy} onClick={() => setDraft(null)}><IconChevronRight size={16} /></button><h2>{draft.original ? String(draft.entry.displayName || draft.entry.name) : `新增${TITLES[draft.kind]}`}</h2><span className="ss-hint">{!draft.original ? '尚未保存' : dirty ? '有未保存的修改' : '已保存'}</span></div><button className="btn btn-ghost" disabled={!!busy} onClick={() => { drafts.delete(draftKey(draft.kind, draft.identity)); setDraft(null); }}>放弃草稿</button></div>
        {draft.invalidated && <div className="ss-inline"><p className="ss-error">{draft.invalidated}</p><button className="btn" disabled={!!busy} onClick={() => void reloadDraft()}>读取最新内容并放弃此草稿</button><button className="btn" disabled={!!busy} onClick={() => { drafts.delete(draftKey(draft.kind, draft.identity)); remember({ ...draft, original: null, identity: null, entry: draft.kind === "share" ? { ...draft.entry, token: "" } : draft.entry, baseline: pretty(createEntry(draft.kind)), invalidated: undefined, serviceName: undefined }); }}>另存为新条目</button></div>}{draft.serviceName && <p className="ss-error">服务名称已是 {draft.serviceName}，应用引用迁移尚未完成。请重试保存。</p>}{draft.kind === 'share' && <p className="ss-hint">{PRIVATE_SHARE_HINT} {draft.original ? '保存修改会先创建新令牌，成功后归档旧分享。请在列表复制更新后的令牌。' : '新令牌创建后可在列表复制。'}</p>}<EntryEditor key={`${draft.kind}:${draft.identity ?? "@new"}`} kind={draft.kind} entry={draft.entry} sources={lists.sub} collections={lists.collection} busy={!!busy} onValidity={setValid} onChange={entry => remember({ ...draftRef.current!, entry })} jsonDrafts={draft.jsonDrafts} onJsonDraft={updateJsonDraft} editorSection={draft.section} onSectionChange={section => remember({ ...draftRef.current!, section })} failure={canLocate ? failure : undefined} focusStep={focusStep} />
        <footer className="ss-editor-footer"><div>{failure && (failure.processor || failure.trace) && <ProcessorFailureNotice failure={failure} busy={!!busy} action={failureAction} onLocate={() => void locateFailure()} onTrace={showFailureTrace} />}<p className="ss-error" role="alert">{error}</p><p className="ss-hint" role="status">{busy || message}</p></div><div className="ss-inline">{previewPhase ? <button className="btn" disabled={previewPhase === 'cancelling'} onClick={() => void cancelPreview()}>{previewPhase === 'cancelling' ? '正在停止…' : '取消预览'}</button> : (draft.kind === 'sub' || draft.kind === 'collection' || draft.kind === 'file') && <button className="btn" disabled={!!busy || !valid} onClick={() => void preview()}>真实预览</button>}<button className="btn btn-primary" disabled={!!busy || !valid || !!draft.invalidated || (!!draft.original && !dirty)} onClick={() => void persist()}>保存草稿</button></div></footer></>
      : <><div className="ss-toolbar"><Segmented ariaLabel="Sub-Store 内容" value={tab} options={Object.entries(TITLES).map(([value, label]) => ({ value: value as Tab, label }))} onChange={setTab} disabled={!!busy} /><div className="ss-toolbar-right"><SearchField value={query} disabled={!!busy} onChange={setQuery} ariaLabel="搜索 Sub-Store" /><button className="icon-btn" aria-label="刷新 Sub-Store 列表" disabled={!!busy} onClick={() => void run('正在刷新…', () => refresh())}><IconRefresh size={16} /></button>{tab !== 'archive' && <button className="icon-btn ss-add" aria-label={`新增${TITLES[tab]}`} disabled={!!busy} onClick={() => void openEditor(null)}><IconPlus size={16} /></button>}</div></div>
        {tab === 'share' && <p className="ss-hint">{PRIVATE_SHARE_HINT}</p>}{readError && <ReadError message={readError} busy={!!busy} onRetry={() => void run('正在重试…', () => refresh())} />}
        {batchMode && currentLists.length > 0 && <BatchToolbar batch={batch} kind={tab} busy={!!busy} onDone={closeBatch} />}
        <div className="ss-list-scroll"><div className="ss-list"><div className="ss-section-head"><h2>{TITLES[tab]}<small>{currentLists.length}</small></h2><div className="ss-section-actions">{currentLists.length > 0 && !batchMode && <button className="btn btn-sm btn-ghost" disabled={!!busy} onClick={() => setBatchMode(true)}>批量操作</button>}{!currentLists.length && batchMode && <button className="btn btn-sm btn-ghost" disabled={!!busy} onClick={closeBatch}>完成</button>}{contentKind && currentLists.length > 0 && <Select ariaLabel="导出格式" value={target} options={outputTargets.map(value => ({ value, label: value }))} onChange={setTarget} disabled={!!busy} />}{tab === 'artifact' && lists.artifact.length > 0 && <button className="btn btn-sm" disabled={!!busy || !lists.artifact.length} onClick={() => void run('正在同步全部任务…', async () => { await requestSubStore('/api/sync/artifacts'); await refresh(); setMessage('同步任务已完成'); })}>全部同步</button>}</div></div>
          {currentLists.map((entry, index) => <div className="ss-list-row" key={entryIdentity(tab, entry)}>{batchMode && <Checkbox className="ss-batch-row-select" ariaLabel={`选择 ${String(entry.displayName || entry.name)}`} checked={batch.isSelected(entry)} disabled={!!busy} onChange={() => batch.toggle(entry)} />}<div className="ss-entry-copy"><button className="ss-entry-name" disabled={!!busy || tab === 'archive'} title={String(entry.displayName ?? entry.name)} onClick={() => void openEditor(entry)}>{String(entry.displayName || entry.name)}</button><p title={tab === 'file' && isMihomoFile(entry) ? mihomoFileSourceLabel(entry) : String(entry.url ?? entry.remark ?? '')}>{tab === 'archive' ? `${String(entry.itemType)} · ${new Date(Number(entry.archivedAt)).toLocaleString()}` : tab === 'share' ? `${entry.type} · ${entry.mode ?? '分享'} · ${entry.usedCount ?? 0} 次使用` : tab === 'collection' ? `${Array.isArray(entry.subscriptions) ? entry.subscriptions.join('、') : ''}` : tab === 'file' && isMihomoFile(entry) ? mihomoFileSourceLabel(entry) : String(entry.url || entry.remark || (entry.source === 'local' ? '本地内容' : entry.source || ''))}</p></div>
            {linked(tab, entry.name).length > 0 && <span className="ss-linked">已加入应用</span>}
            <div className="ss-row-actions">{contentKind && <><button className="btn btn-sm" disabled={!!busy} onClick={() => void generate(tab as Kind, entry.name)}>导出</button>{tab !== 'file' && <button className="btn btn-sm" disabled={!!busy || linked(tab, entry.name).length > 0} onClick={() => void generate(tab as Kind, entry.name, true)}>加入应用</button>}</>}
              {tab === 'artifact' && lists.artifact.length > 0 && <button className="btn btn-sm" disabled={!!busy} onClick={() => void run('正在同步…', async () => { await requestSubStore(`/api/sync/artifact/${encodeURIComponent(entry.name)}`); await refresh(); setMessage('同步已完成'); })}>同步</button>}
              {tab === 'share' && <button className="btn btn-sm" disabled={!!busy} onClick={() => void run('正在复制…', async () => { await navigator.clipboard.writeText(String(entry.token)); setMessage('令牌已复制'); })}>复制令牌</button>}
              {tab === 'archive' && <button className="btn btn-sm" disabled={!!busy} onClick={() => void run('正在恢复归档…', async () => { await requestSubStore(`/api/archives/${encodeURIComponent(String(entry.id))}/restore`, {}, 'POST'); await refresh(); setMessage('条目已恢复'); })}>恢复</button>}
              <button className="btn btn-sm btn-ghost" disabled={!!busy} onClick={() => void run('正在检查引用…', async () => { if (tab === 'sub') await refresh('collection'); setDeleting(entry); })}>{tab === 'share' ? '撤销' : tab === 'archive' ? '删除' : '归档 / 删除'}</button>
              {index > 0 && tab !== 'archive' && <button className="icon-btn ss-up" aria-label={`上移 ${entry.name}`} disabled={!!busy} onClick={() => void run('正在调整顺序…', async () => { const items = [...lists[tab]]; const at = items.indexOf(entry); [items[at - 1], items[at]] = [items[at], items[at - 1]]; await requestSubStore(`/api/sort/${tab === 'share' ? 'tokens' : tab === 'sub' ? 'subs' : tab === 'collection' ? 'collections' : tab === 'file' ? 'files' : 'artifacts'}`, tab === 'share' ? items.map(value => `${value.type}-${value.name}-${value.token}`) : items.map(value => value.name), 'POST'); await refresh(); })}><IconChevronRight size={14} /></button>}</div></div>)}
          {!currentLists.length && !busy && <EmptyState compact title={query ? '没有匹配的条目' : `尚无${TITLES[tab]}`} desc={query ? '换个关键词试试' : tab === 'archive' ? '归档的内容会显示在这里' : undefined} action={!query && tab !== 'archive' ? <button className="btn btn-sm" onClick={() => void openEditor(null)}>新增{TITLES[tab]}</button> : undefined} />}{busy && !currentLists.length && <EmptyState compact loading title={busy} />}</div></div>
        <BatchFeedback batch={batch} />
        <footer className="ss-bottom-note"><div>{[...drafts.values()].filter(value => value.kind === tab).map(value => <button className="btn btn-ghost btn-sm" key={draftKey(value.kind, value.identity)} disabled={!!busy} onClick={() => void run('正在恢复草稿…', async () => { if (value.kind === 'file') { await refresh('sub'); await refresh('collection'); } setValid(!Object.keys(value.jsonDrafts ?? {}).length); setDraft(value); })}>恢复草稿 · {String(value.entry.displayName || value.entry.name || TITLES[value.kind])}</button>)}<p className="ss-error" role="alert">{error}</p><span role="status">{busy || message}</span></div><div className="ss-inline">{importPhase && <button className="btn" disabled={importPhase === 'cancelling'} onClick={() => void cancelImport()}>{importPhase === 'cancelling' ? '正在停止…' : '取消生成'}</button>}{exportPhase && <button className="btn" disabled={exportPhase === 'cancelling'} onClick={() => void cancelExport()}>{exportPhase === 'cancelling' ? '正在停止…' : '取消导出'}</button>}</div></footer></>}
    </div>}
    {result && <Dialog labelledBy="ss-result-title" busy={!!busy} onDismiss={() => setResult(null)}><div className="ss-result"><header className="ss-editor-heading"><h3 id="ss-result-title">{result.title}</h3><button className="icon-btn" aria-label="关闭预览" disabled={!!busy} onClick={() => setResult(null)}><IconX size={16} /></button></header><div className="ss-result-body">{result.trace ? <><p className="ss-error ss-trace-error">{result.traceError}</p><ProcessorTraceResults trace={result.trace} /></> : result.preview !== undefined ? <PreviewResults value={result.preview} /> : <pre>{result.text}</pre>}</div><div className="modal-actions"><button className="btn" disabled={!!busy} onClick={() => void run('正在复制…', async () => { await navigator.clipboard.writeText(result.preview === undefined ? result.text : typeof result.preview === 'string' ? result.preview : pretty(result.preview)); setMessage('内容已复制'); }, true)}>复制内容</button>{result.exportable && <button className="btn btn-primary" disabled={!!busy} onClick={() => void run('正在导出…', () => exportText(result.text, result.title))}>保存文件</button>}</div>{error && <p className="ss-error" role="alert">{error}</p>}{message && <p className="ss-hint" role="status">{message}</p>}</div></Dialog>}
    <BatchConfirmation batch={batch} busy={!!busy} />
    {deleting && <Dialog labelledBy="ss-delete-title" busy={!!busy} onDismiss={() => setDeleting(null)}><h3 id="ss-delete-title">{tab === 'share' ? '撤销分享' : tab === 'archive' ? '永久删除归档' : '归档或删除条目'}</h3><p className="modal-desc">{String(deleting.displayName || deleting.name)}{tab === 'share' ? '的令牌将立即失效。' : '：归档可以恢复，永久删除无法撤销。'}</p>{applicationLinks.length > 0 && <p className="ss-error">关联应用订阅：{applicationLinks.map(profile => profile.name).join('、')}。删除后现有内容保留，但无法继续更新。</p>}{dependentCollections.length > 0 && <p className="ss-error">被组合引用：{dependentCollections.map(entry => entry.name).join('、')}。归档或删除会移除组合成员；恢复来源后需重新选择。</p>}<div className="modal-actions"><button className="btn" disabled={!!busy} onClick={() => setDeleting(null)}>取消</button>{tab !== 'archive' && <button className="btn" disabled={!!busy} onClick={() => void remove(true)}>归档</button>}<button className="btn btn-danger" disabled={!!busy} onClick={() => void remove(false)}>{tab === 'share' ? '确认撤销' : '永久删除'}</button></div>{error && <p className="ss-error" role="alert">{error}</p>}</Dialog>}
    {backendSettings && <BackendSettingsDialog value={backendSettings} onChange={setBackendSettings} busy={!!busy} dirty={pretty(backendSettings) !== settingsBaseline} valid={settingsValid} onValidity={setSettingsValid} onClose={() => setBackendSettings(null)} onSave={() => void run('正在保存后端设置…', async () => { await requestSubStore('/api/settings', backendSettings, 'PATCH'); setSettingsBaseline(pretty(backendSettings)); setMessage('后端设置已保存'); })} error={error} message={message} />}
  </div>;
}
