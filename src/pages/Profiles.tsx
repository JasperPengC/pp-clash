import { PageHeader } from '../components/PageHeader';
import { ProfileCollectionDialog } from '../components/ProfileCollectionDialog';
import { Dialog } from '../components/Dialog';
import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { MiniSwitch, Select } from '../components/ui';
import { IconSliders, IconAlert, IconCheck, IconChevronRight, IconEdit, IconFolder, IconPlus, IconProfiles, IconRefresh, IconSort, IconTrash, IconX } from '../components/icons';
import { useApp } from '../store/app';
import type { Profile } from '../domain/app';
import { isTauri, previewMode } from '../core/api';
import { isAndroid } from '../core/platform';
import { open } from '@tauri-apps/plugin-dialog';
import { SubscriptionImport } from '../components/SubscriptionImport';
import { countRealNodes, type TrafficInfo } from '../core/subscription';
import { daysUntil, formatBytes, formatExpire, formatTime } from '../core/format';

const AUTO_OPTIONS = (followHours: number | null) => [
  { value: 'auto', label: `跟随订阅（${followHours ?? 24}h）` },
  { value: '6', label: '每 6 小时' },
  { value: '12', label: '每 12 小时' },
  { value: '24', label: '每 24 小时' },
  { value: '48', label: '每 48 小时' },
  { value: 'off', label: '关闭自动更新' },
];

function profileSource(profile: Profile): string {
  if (profile.sourceType === 'substore') return `Sub-Store · ${profile.subStore?.kind === 'collection' ? '组合' : '来源'} · ${profile.subStore?.name ?? '来源待确认'}`;
  if (profile.sourceType === 'collection') return `Sub-Store · ${profile.collection?.sources.length ?? 0} 个来源`;
  if (profile.sourceType === 'file') return profile.url ? '本地配置' : '备份副本 · 待关联本机文件';
  try { return new URL(profile.url).hostname; } catch { return '远程订阅'; }
}

function QuotaCell({ info }: { info: TrafficInfo | null }) {
  if (!info) return <div className="sub-empty">未提供用量与到期信息</div>;

  const used = Math.max(info.upload + info.download, 0);
  const total = Math.max(info.total, 0);
  const ratio = total > 0 ? Math.min(used / total, 1) : 0;
  const remaining = Math.max(total - used, 0);
  const [remainingValue, remainingUnit] = formatBytes(remaining).split(' ');
  const tone = ratio >= 0.9 ? 'bad' : ratio >= 0.7 ? 'warn' : 'ok';
  const days = daysUntil(info.expire);
  const expired = days != null && days < 0;

  return (
    <div className="sub-quota">
      <div className="sub-quota-summary">
        {total > 0 && <strong className="sub-quota-remaining"><b>{remainingValue}<small> {remainingUnit}</small></b><span>剩余</span></strong>}
        <span className="sub-quota-used" title={`已用 ${formatBytes(used)}${total > 0 ? ` / ${formatBytes(total)}` : ''}`}>{total <= 0 && '已用 '}{formatBytes(used)}{total > 0 ? ` / ${formatBytes(total)}` : ''}</span>
      </div>
      {total > 0 && (
        <div className="progress sub-progress" role="progressbar" aria-label="订阅用量" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)}>
          <span className={`progress-fill ${tone}`} style={{ width: `${ratio * 100}%` }} />
        </div>
      )}
      <div className={`sub-quota-line sub-quota-sub${expired ? ' quota-expired' : ''}`}>
        <span>{info.expire > 0 ? `${formatExpire(info.expire)} 到期` : '不限期'}</span>
        {info.expire > 0 && <span>{expired ? '已过期' : days != null ? `剩 ${days} 天` : ''}</span>}
      </div>
    </div>
  );
}

function ProfileEditor({ profile, busy, refreshing, index, total, onUpdate, onMove, onRefresh, onClose, returnFocus }: {
  profile: Profile; busy: boolean; refreshing: boolean; index: number; total: number;
  onUpdate: (patch: Partial<Profile>) => void; onMove: (dir: -1 | 1) => void;
  onRefresh: () => void;
  onClose: () => void; returnFocus: HTMLElement | null;
}) {
  const headingId = useId();
  const [source, setSource] = useState(profile.url);
  const [hours, setHours] = useState(profile.autoUpdateHours ?? null);
  const [proxy, setProxy] = useState(Boolean(profile.useProxy));
  const [picking, setPicking] = useState(false);
  const [saved, setSaved] = useState(false);
  const sourceInput = useRef<HTMLInputElement>(null);
  const local = profile.sourceType === 'file';
  const subStore = profile.sourceType === 'substore';
  const changed = source.trim() !== profile.url || hours !== (profile.autoUpdateHours ?? null) || proxy !== Boolean(profile.useProxy);
  useEffect(() => { sourceInput.current?.focus(); }, []);

  const replaceFile = async () => {
    if (!isTauri || busy || picking) return;
    setPicking(true);
    try {
      const path = await open({ multiple: false, directory: false,
        filters: isAndroid ? undefined : [{ name: 'Clash / mihomo 配置', extensions: ['yaml', 'yml', 'json'] }] });
      if (typeof path === 'string' && path) { setSource(path); setSaved(false); }
    } catch (error) {
      useApp.getState().notify('error', `选择文件失败：${String(error)}`);
    } finally { setPicking(false); }
  };

  return <Dialog labelledBy={headingId} busy={busy || picking} returnFocus={returnFocus} onDismiss={onClose}>
    <div className="profiles-page profile-editor-dialog">
    <form className="sub-editor" aria-label={`编辑 ${profile.name}`} onSubmit={event => {
    event.preventDefault();
    if (busy || picking || (!subStore && !source.trim())) return;
    onUpdate(subStore ? { autoUpdateHours: hours } : { url: source.trim(), autoUpdateHours: hours, useProxy: proxy });
    setSaved(true);
  }}>
    <div className="sub-editor-heading"><div className="sub-editor-title"><h3 id={headingId}>编辑订阅</h3><span title={profile.name}>{profile.name}</span></div>
      <button type="button" className="icon-btn" aria-label="关闭订阅编辑" disabled={busy || picking} onClick={onClose}><IconX size={16} /></button></div>
    <label className="sub-editor-field"><span>{subStore ? 'Sub-Store 来源' : local ? '本地文件' : '订阅 URL'}</span>
      <div className="sub-source-field">
        <input ref={sourceInput} className="input" type={local || subStore ? 'text' : 'url'} required={!subStore}
          pattern={local || subStore ? undefined : 'https?://.+'} readOnly={local || subStore} disabled={busy || picking}
          aria-label={subStore ? 'Sub-Store 来源' : local ? '本地文件路径' : '订阅 URL'} value={subStore ? profile.subStore?.name ?? '' : source} spellCheck={false}
          onChange={event => { setSource(event.target.value); setSaved(false); }} />
        {local && <button type="button" className="btn" disabled={!isTauri || busy || picking} onClick={() => void replaceFile()}>
          <IconFolder size={14} />{picking ? '选择中…' : '更换文件'}
        </button>}
        {subStore && <button type="button" className="btn" disabled={busy || picking} onClick={() => { onClose(); window.dispatchEvent(new CustomEvent('ppclash:nav', { detail: 'substore' })); }}>管理来源</button>}
      </div>
    </label>
    <div className="sub-editor-settings">
      <div className="sub-editor-setting"><span>自动更新间隔</span><Select disabled={busy || picking}
        value={hours === 0 ? 'off' : hours == null ? 'auto' : String(hours)}
        options={AUTO_OPTIONS(profile.updateIntervalHours)} ariaLabel="自动更新间隔"
        onChange={value => { setHours(value === 'auto' ? null : value === 'off' ? 0 : Number(value)); setSaved(false); }} />
      </div>
      {!local && !subStore && <div className="sub-editor-setting"><span>使用代理更新</span>
        <MiniSwitch on={proxy} disabled={busy || picking} label="经代理更新" onChange={value => { setProxy(value); setSaved(false); }} />
      </div>}
      <div className="sub-editor-setting"><span>订阅顺序 <span className="sub-order-index">{index + 1} / {total}</span></span>
        <div className="sub-order-control" role="group" aria-label="调整订阅顺序">
        <button type="button" className="icon-btn" aria-label="上移订阅" title="上移订阅" disabled={busy || picking || index === 0} onClick={() => onMove(-1)}><IconChevronRight size={14} className="sub-move-up" /></button>
        <button type="button" className="icon-btn" aria-label="下移订阅" title="下移订阅" disabled={busy || picking || index === total - 1} onClick={() => onMove(1)}><IconChevronRight size={14} className="sub-move-down" /></button>
        </div>
      </div>
    </div>
    <p className={`sub-editor-hint${saved ? ' sub-editor-saved' : ''}`} role="status">{saved ? '修改已保存，可以更新订阅。' : subStore ? '更新时从 Sub-Store 重新生成。来源和处理器在 Sub-Store 中编辑，失败保留上次可用配置。' : '保存来源后再更新；更新失败时保留上次可用配置。'}</p>
    <div className="sub-editor-footer">
      <div className="sub-editor-tools">
        <button type="button" className="icon-btn" aria-label="更新订阅" aria-busy={refreshing}
          title={changed ? '先保存修改，再更新订阅' : '更新订阅'} disabled={busy || picking || changed || refreshing} onClick={onRefresh}>
          <IconRefresh size={16} className={refreshing ? 'spin' : undefined} />
        </button>
      </div>
      <div className="sub-editor-controls">
        <button type="button" className="btn btn-ghost" disabled={busy || picking} onClick={onClose}>取消编辑</button>
        <button type="submit" className="btn btn-primary" disabled={busy || picking || (!subStore && !source.trim()) || !changed}>保存修改</button>
      </div>
    </div>
  </form>
  </div></Dialog>;
}

function ProfileCard({ profile, active, busy, nodeCount, refreshing, refreshError,
  editing, editMode, index, total, status, statusTone, onActivate, onRefresh, onDelete, onUpdate,
  onMove, onEdit, onClose, dragging, dropTarget, onDragHandle }: {
  profile: Profile; active: boolean; busy: boolean; nodeCount: number;
  refreshing: boolean; refreshError?: string; editing: boolean; editMode: boolean;
  index: number; total: number; status: string; statusTone: 'ok' | 'warn' | 'bad' | 'neutral';
  onActivate: () => void; onRefresh: () => void; onDelete: () => void;
  onUpdate: (patch: Partial<Profile>) => void; onMove: (dir: -1 | 1) => void;
  onEdit: () => void; onClose: () => void; dragging: boolean; dropTarget: boolean;
  onDragHandle: (e: ReactPointerEvent<HTMLSpanElement>) => void;
}) {
  const editButton = useRef<HTMLButtonElement>(null);
  const interval = profile.autoUpdateHours ?? profile.updateIntervalHours ?? 24;
  return <section className={`card sub-card${active ? ' sub-hero' : ''}${editMode ? ' edit-mode' : ''}${dragging ? ' dragging' : ''}${dropTarget ? ' drop-target' : ''}`}
    data-profile-id={profile.id} aria-label={active ? '当前订阅' : `订阅 ${profile.name}`}>
    {editMode && <span className="drag-handle" title="拖拽排序" aria-hidden="true" onPointerDown={event => { if (!busy) onDragHandle(event); }}>
      <svg width="12" height="18" viewBox="0 0 12 18" fill="currentColor" aria-hidden="true">
        {[5, 9, 13].map(y => <g key={y}><circle cx="4" cy={y} r=".8" /><circle cx="8" cy={y} r=".8" /></g>)}
      </svg>
    </span>}
    <div className="sub-card-heading">
      <div className="sub-title">
        <h2 className="sub-name" title={profile.name}>{profile.name}</h2>
        {active && <span className={`sub-current ${statusTone}`} title={`当前订阅 · ${status}`}><IconCheck size={10} />使用中</span>}
      </div>
      <div className="sub-meta"><span className="sub-source" title={profileSource(profile)}>{profileSource(profile)}</span><span aria-hidden="true">·</span><span>{nodeCount} 个节点</span></div>
    </div>
    <QuotaCell info={profile.userinfo} />
    {refreshError && <div className="sub-update-error" role="status"><IconAlert size={14} /><span>{refreshError}</span></div>}
    <div className="sub-card-actions">
      <div className="sub-card-updated">
        <span className="sub-update-time" title={`更新于 ${formatTime(profile.updatedAt)}`}>{refreshing ? '正在更新…' : `${formatTime(profile.updatedAt)} 更新`}</span>
        {active && <><span className="sub-update-separator" aria-hidden="true">·</span><span className="sub-update-interval" title={`${interval === 0 ? '自动更新已关闭' : `自动更新周期：每 ${interval} 小时`}${profile.sourceType !== 'file' && profile.useProxy ? ' · 经代理更新' : ''}`}>{interval === 0 ? '自动更新已关闭' : `每 ${interval} 小时`}</span></>}
      </div>
      <div className="sub-card-tools">
      <button type="button" className="icon-btn" aria-label={`更新订阅 ${profile.name}`} aria-busy={refreshing} title="更新订阅" disabled={busy || refreshing} onClick={onRefresh}>
        <IconRefresh size={16} className={refreshing ? 'spin' : undefined} />
      </button>
      <button ref={editButton} type="button" className="icon-btn" aria-label={`编辑订阅 ${profile.name}`} title="编辑订阅" aria-haspopup="dialog" aria-expanded={editing} aria-controls={`profile-edit-${profile.id}`}
        disabled={busy} onClick={onEdit}><IconEdit size={16} /></button>
      {!active && <button type="button" className="icon-btn sub-switch" disabled={busy} aria-label={`使用订阅 ${profile.name}`} title="使用订阅" onClick={onActivate}><IconCheck size={16} /></button>}
      <button type="button" className="icon-btn danger" aria-label={`删除订阅 ${profile.name}`}
        title="删除订阅" disabled={busy} onClick={onDelete}><IconTrash size={16} /></button>
      </div>
    </div>
    {editing && profile.sourceType === 'collection' && <ProfileCollectionDialog profile={profile} onClose={onClose} />}
    {editing && profile.sourceType !== 'collection' && <ProfileEditor profile={profile} busy={busy} refreshing={refreshing} index={index} total={total}
      onUpdate={onUpdate} onMove={onMove}
      onRefresh={onRefresh} returnFocus={editButton.current} onClose={onClose} />}
  </section>;
}

export function ProfilesPage() {
  const profiles = useApp((s) => s.profiles);
  const activeId = useApp((s) => s.activeId);
  const importProfile = useApp((s) => s.importProfile);
  const importProfileFile = useApp((s) => s.importProfileFile);
  const activate = useApp((s) => s.activate);
  const removeProfile = useApp((s) => s.removeProfile);
  const refreshProfile = useApp((s) => s.refreshProfile);
  const updateProfile = useApp((s) => s.updateProfile);
  const moveProfile = useApp((s) => s.moveProfile);
  const reorderProfiles = useApp((s) => s.reorderProfiles);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragOverRef = useRef<string | null>(null);

  useEffect(() => {
    if (!dragId) return;
    const onMove = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const row = el instanceof Element ? el.closest<HTMLElement>('[data-profile-id]') : null;
      const over = row?.dataset.profileId ?? null;
      dragOverRef.current = over;
      setDragOverId(over);
    };
    const onUp = () => {
      const over = dragOverRef.current;
      if (over && over !== dragId) reorderProfiles(dragId, over);
      dragOverRef.current = null;
      setDragOverId(null);
      setDragId(null);
    };
    const onCancel = () => {
      dragOverRef.current = null;
      setDragOverId(null);
      setDragId(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onCancel);
    };
  }, [dragId, reorderProfiles]);
  const stats = useApp((s) => s.stats);
  const activating = useApp(s => s.activatingProfile);
  const importing = useApp((s) => s.importing);
  const refreshingIds = useApp((s) => s.refreshingIds);
  const refreshErrors = useApp((s) => s.profileRefreshErrors);
  const kernelPhase = useApp(s => s.kernelPhase);
  const kernelError = useApp(s => s.kernelError);
  const transition = useApp(s => s.runtimeConfigTransition);

  const [composing, setComposing] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [ordering, setOrdering] = useState(false);
  const globalBusy = activating || importing || transition || kernelPhase === 'starting' || kernelPhase === 'stopping';
  const manageBusy = globalBusy || refreshingIds.length > 0;
  const activeProfile = profiles.find(profile => profile.id === activeId);
  const confirmProfile = profiles.find(profile => profile.id === confirmId);
  const status = activating || transition ? '正在切换配置' : kernelPhase === 'failed' ? '连接失败'
    : kernelPhase === 'running' ? kernelError ? '运行状态未确认' : '运行中' : kernelPhase === 'starting' ? '启动中'
      : kernelPhase === 'stopping' ? '停止中' : '未连接';
  const statusTone = kernelError || kernelPhase === 'failed' ? 'bad' : kernelPhase === 'running' && !activating && !transition ? 'ok'
    : globalBusy ? 'warn' : 'neutral';

  useEffect(() => {
    if (editingId && !profiles.some(profile => profile.id === editingId)) setEditingId(null);
  }, [profiles, editingId]);
  useEffect(() => {
    if (manageBusy || !ordering) { setDragId(null); setDragOverId(null); dragOverRef.current = null; }
  }, [manageBusy, ordering]);

  const nodeCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const p of profiles) out[p.id] = countRealNodes(p.raw);
    return out;
  }, [profiles]);

  const askDelete = (id: string) => {
    if (globalBusy || refreshingIds.includes(id)) return;
    setConfirmId(id);
  };
  const cancelDelete = () => setConfirmId(null);
  const confirmDelete = () => {
    if (!confirmId || globalBusy || refreshingIds.includes(confirmId)) return;
    const id = confirmId;
    setConfirmId(null);
    void removeProfile(id);
  };

  const refreshAll = () => {
    if (manageBusy || refreshingAll) return;
    const notify = useApp.getState().notify;
    setRefreshingAll(true);
    void Promise.all(profiles.map((p) => refreshProfile(p.id, true)))
      .then((results) => {
        if (results.every(Boolean)) notify('success', '所有订阅已更新');
        else notify('error', '部分订阅更新失败');
      })
      .finally(() => setRefreshingAll(false));
  };

  const renderProfile = (profile: Profile) => <ProfileCard key={profile.id} profile={profile}
    active={profile.id === activeId} busy={globalBusy || refreshingIds.includes(profile.id)}
    nodeCount={nodeCounts[profile.id] ?? 0} refreshing={refreshingIds.includes(profile.id)} refreshError={refreshErrors[profile.id]}
    editing={editingId === profile.id} editMode={ordering} index={profiles.indexOf(profile)} total={profiles.length}
    status={status} statusTone={statusTone} onActivate={() => { if (!globalBusy && !refreshingIds.includes(profile.id)) void activate(profile.id); }}
    onRefresh={() => { if (!globalBusy && !refreshingIds.includes(profile.id)) void refreshProfile(profile.id); }} onDelete={() => askDelete(profile.id)}
    onUpdate={patch => { if (!globalBusy && !refreshingIds.includes(profile.id)) updateProfile(profile.id, patch); }}
    onMove={dir => { if (!globalBusy && !refreshingIds.includes(profile.id)) moveProfile(profile.id, dir); }} onEdit={() => {
      setEditingId(editingId === profile.id ? null : profile.id); setConfirmId(null); setAdding(false); setOrdering(false);
    }} onClose={() => { setEditingId(null); setConfirmId(null); }} dragging={dragId === profile.id}
    dropTarget={dragOverId === profile.id && dragId !== profile.id} onDragHandle={event => {
      event.preventDefault(); event.stopPropagation(); setDragOverId(null); setDragId(profile.id);
    }} />;

  return (
    <>
      <PageHeader title="订阅" className="profiles-page-header" subtitle={profiles.length > 0 ? `${profiles.length} 份订阅 · ${Object.values(nodeCounts).reduce((sum, count) => sum + count, 0)} 个节点` : '还没有订阅'} mobileSubtitle={`${profiles.length} 份`}>
          <button type="button" className="icon-btn" aria-label="组合订阅" title="组合订阅 · Sub-Store" disabled={manageBusy} onClick={() => setComposing(true)}><IconSliders size={16} /></button>
          {profiles.length > 1 && <button type="button" className="icon-btn" aria-label="订阅排序" title={ordering ? '完成排序' : '排序订阅'}
            aria-pressed={ordering} disabled={manageBusy} onClick={() => { setOrdering(value => !value); setEditingId(null); setConfirmId(null); }}><IconSort size={16} /></button>}
          {profiles.length > 1 && (
            <button
              type="button"
              className="btn"
              aria-label="全部更新"
              title="全部更新"
              aria-busy={refreshingAll}
              disabled={manageBusy || refreshingAll}
              onClick={refreshAll}
            >
              <IconRefresh size={16} className={refreshingAll ? 'spin' : undefined} />
              <span className="profile-action-label">全部更新</span>
            </button>
          )}
          {<button type="button" className="btn btn-primary" aria-label="添加订阅" title="添加订阅" disabled={globalBusy}
            onClick={() => { setAdding(true); setEditingId(null); setConfirmId(null); setOrdering(false); }}>
            <IconPlus size={17} /><span className="profile-action-label">添加订阅</span>
          </button>}

      </PageHeader>

      <div className="page-scroll profiles-scroll">
        <div className="page-inner profiles-page">
          {!isTauri && !previewMode && (
            <div className="banner warn">
              <IconAlert size={14} />
              <span>浏览器预览模式无法拉取订阅，请打开 PP Clash.app。</span>
            </div>
          )}

          {activeProfile && renderProfile(activeProfile)}
          {profiles.length === 0 && <div className="sub-page-empty"><IconProfiles size={32} /><h2>还没有订阅</h2><p>添加订阅链接或本地配置文件</p></div>}

          {profiles.length > 0 ? (
            <section className="sub-list" aria-label="订阅列表">
              <div className="sub-list-heading">
                <h2 className="section-title">{activeProfile ? '其他订阅' : '我的订阅'}</h2>
                <span>{ordering ? '拖动卡片调整顺序' : `${profiles.filter(profile => profile.id !== activeId).length} 份`}</span>
              </div>
              <div className="sub-card-flow" role="region" aria-label="订阅卡片" tabIndex={0}>
              {profiles.filter(profile => profile.id !== activeId).map(renderProfile)}
              {profiles.filter(profile => profile.id !== activeId).length === 0 && <p className="sub-others-empty">暂无其他订阅</p>}
              </div>
            </section>
          ) : null}

          {stats && (
            <section className="profiles-stats" aria-label="当前配置统计">
              <span>当前配置</span>
                {[
                  { label: '节点', value: stats.proxyCount },
                  { label: '分组', value: stats.groupCount },
                  { label: '规则', value: stats.ruleCount },
                  { label: '防护规则', value: stats.guardRuleCount },
                ].map((x) => (
                  <span key={x.label}><strong>{x.value}</strong> {x.label}</span>
                ))}
            </section>
          )}
        </div>
      </div>
      {composing && <ProfileCollectionDialog onClose={() => setComposing(false)} />}
      <SubscriptionImport visible={adding} busy={globalBusy} profiles={profiles}
        running={kernelPhase === 'running'} onClose={() => setAdding(false)}
        onImportUrl={importProfile} onImportFile={importProfileFile} />
      {confirmProfile && <Dialog labelledBy="profile-delete-title" describedBy="profile-delete-description"
        busy={globalBusy} onDismiss={cancelDelete}>
        <section className="profile-delete-dialog" aria-label={`确认删除订阅 ${confirmProfile.name}`}>
          <div className="profile-delete-copy">
            <h2 id="profile-delete-title">删除订阅</h2>
            <p id="profile-delete-description">确认从此设备移除“{confirmProfile.name}”吗？{confirmProfile.id === activeId ? '当前正在使用，删除后会断开连接。' : ''}</p>
          </div>
          <div className="profile-delete-actions">
            <button type="button" className="btn btn-ghost" aria-label="取消删除订阅" disabled={globalBusy} onClick={cancelDelete}>取消</button>
            <button type="button" className="btn btn-danger" aria-label={`确认删除订阅 ${confirmProfile.name}`} disabled={globalBusy}
              onClick={confirmDelete}><IconTrash size={14} />删除</button>
          </div>
        </section>
      </Dialog>}
    </>
  );
}
