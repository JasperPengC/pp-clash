import { useEffect, useId, useRef, useState } from 'react';
import { api, type WebDavBackupPreview, type WebDavCredentialChange, type WebDavSettings, type WebDavSettingsSnapshot } from '../core/api';
import { webdavService, type WebDavBackupHistory, type WebDavBackupStatus } from '../core/webdav-service';
import { isAndroid } from '../core/platform';
import { useApp } from '../store/app';
import { Dialog } from './Dialog';
import { EmptyState, FormRow, ReadError, Select } from './ui';
import { IconChevronRight, IconRefresh, IconX } from './icons';
import './webdav-backup.css';

const KEEP: WebDavCredentialChange = { intent: 'keep' };
const when = (time: number | null) => time == null ? '暂无' : new Date(time).toLocaleString();
const describeError = (reason: unknown) => typeof reason === 'object' && reason && 'message' in reason ? String(reason.message) : String(reason);

function SecretField({ label, saved, value, onChange, busy }: { label: string; saved: boolean | null; value: WebDavCredentialChange; onChange: (value: WebDavCredentialChange) => void; busy: boolean }) {
  const id = useId();
  const hint = saved === null ? '无法读取保存状态' : label === '备份口令' ? '恢复备份时需要，请妥善保存' : undefined;
  const placeholder = value.intent === 'clear' ? '保存后清除' : saved ? '已保存，留空不变' : `输入${label}`;
  return <FormRow label={label} htmlFor={id} hint={hint} className="dav-row" control={<div className="dav-secret">
    <input id={id} className="input" type="password" autoComplete="new-password" aria-label={label}
      placeholder={placeholder} value={value.intent === 'replace' ? value.value : ''} disabled={busy || value.intent === 'clear'}
      onChange={event => onChange(event.target.value ? { intent: 'replace', value: event.target.value } : KEEP)} />
    {value.intent !== 'keep' ? <button type="button" className="btn btn-sm btn-ghost" aria-label={`撤销${label}修改`} disabled={busy} onClick={() => onChange(KEEP)}>撤销</button>
      : saved !== false && <button type="button" className="btn btn-sm btn-ghost" aria-label={`清除${label}`} disabled={busy} onClick={() => onChange({ intent: 'clear' })}>清除</button>}
  </div>} />;
}

export function WebDavBackup({ mobile = false }: { mobile?: boolean }) {
  const [open, setOpen] = useState(false);
  const [blocked, setBlocked] = useState(false);
  if (mobile || isAndroid) return <><button type="button" className="android-setting-row android-settings-link" onClick={() => setOpen(true)}><span>WebDAV 云备份</span><IconChevronRight size={16} /></button>
    {open && <Dialog className="android-webdav-dialog" labelledBy="android-webdav-title" busy={blocked} onDismiss={() => { if (!blocked) setOpen(false); }}><div className="modal-head"><h3 id="android-webdav-title">WebDAV 云备份</h3><button type="button" className="btn btn-ghost" aria-label="关闭云备份" disabled={blocked} onClick={() => setOpen(false)}><IconX size={18} /></button></div><div className="android-webdav-content"><SavedBackupForm onBusyChange={setBlocked} /></div></Dialog>}</>;
  return <SavedBackupForm />;
}

function SavedBackupForm({ onBusyChange }: { onBusyChange?: (busy: boolean) => void }) {
  const [snapshot, setSnapshot] = useState<WebDavSettingsSnapshot | null>(null);
  const [settings, setSettings] = useState<WebDavSettings | null>(null);
  const [password, setPassword] = useState<WebDavCredentialChange>(KEEP);
  const [backupPassphrase, setBackupPassphrase] = useState<WebDavCredentialChange>(KEEP);
  const [status, setStatus] = useState<WebDavBackupStatus | null>(null);
  const [readError, setReadError] = useState(''); const [statusError, setStatusError] = useState('');
  const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false); const lock = useRef(false); const generation = useRef(0);
  useEffect(() => { onBusyChange?.(!!busy || historyOpen); }, [busy, historyOpen, onBusyChange]);
  const dirty = !!settings && (JSON.stringify(settings) !== JSON.stringify(snapshot?.settings) || password.intent !== 'keep' || backupPassphrase.intent !== 'keep');
  const identityChanged = !!settings && !!snapshot && (settings.endpoint.trim() !== snapshot.settings.endpoint || settings.username !== snapshot.settings.username);
  const identityError = identityChanged && password.intent === 'keep' && snapshot?.hasPassword !== false ? '服务器或账号已改变，请重新输入服务器密码或明确清除，避免沿用其他账号凭据。' : '';
  const invalidSecret = [password, backupPassphrase].some(value => value.intent === 'replace' && !value.value);
  const refreshStatus = async () => { try { setStatus(await webdavService.status()); setStatusError(''); } catch (reason) { setStatusError(describeError(reason)); } };
  async function load() {
    const current = ++generation.current; setReadError('');
    const results = await Promise.allSettled([api.getWebDavSettings(), webdavService.status()]);
    if (generation.current !== current) return;
    if (results[0].status === 'fulfilled') {
      const value = results[0].value;
      if (!value?.settings || !value.credentialStore) setReadError('云备份设置格式异常，请重试读取。');
      else { setSnapshot(value); setSettings(value.settings); }
    } else setReadError(describeError(results[0].reason));
    if (results[1].status === 'fulfilled') { setStatus(results[1].value); setStatusError(''); } else setStatusError(describeError(results[1].reason));
  }
  useEffect(() => { void load(); return () => { generation.current++; }; }, []);
  useEffect(() => {
    const timer = window.setInterval(() => { if (!lock.current && document.visibilityState !== 'hidden') void refreshStatus(); }, 15000);
    return () => window.clearInterval(timer);
  }, []);
  async function run(label: string, action: () => Promise<void>) {
    if (lock.current) return; lock.current = true; setBusy(label); setError(''); setMessage('');
    try { await action(); } catch (reason) { setError(describeError(reason)); } finally { lock.current = false; setBusy(''); }
  }
  const patch = (value: Partial<WebDavSettings>) => setSettings(current => current ? { ...current, ...value } : current);
  const save = () => settings && run('正在保存…', async () => {
    if (identityError || invalidSecret) throw new Error(identityError || '请输入密码或口令；如需移除，请点击清除。');
    const saved = await api.saveWebDavSettings({ settings, password, backupPassphrase });
    setSnapshot(saved); setSettings(saved.settings); setPassword(KEEP); setBackupPassphrase(KEEP); setMessage('设置已保存'); await refreshStatus();
  });
  const test = () => settings && run('正在测试连接…', async () => {
    if (identityError) throw new Error(identityError);
    const result = await api.testWebDavConnection({ settings, password });
    setMessage(result.willCreateOnBackup ? '连接可用，目录将在首次备份时创建；草稿尚未保存。' : `连接可用${dirty ? '；草稿尚未保存。' : '。'}`);
  });
  const backup = () => run('正在加密上传…', async () => {
    const result = await webdavService.backupNow(); setStatus(result.status); setMessage(`备份已上传${result.cleanupError ? '；保留清理未完成' : ''}`); if (result.cleanupError) setError(result.cleanupError);
  });
  if (readError && !settings) return <div className="webdav-backup"><ReadError message={readError} onRetry={() => void load()} /></div>;
  if (!settings || !snapshot) return <EmptyState loading compact title="正在读取云备份设置…" />;
  const statusMessage = !snapshot.configured && status?.error === '请先保存 WebDAV 设置' ? null : status?.error;
  return <div className="webdav-backup">
    <header className="dav-heading"><div><h3>WebDAV 云备份</h3><p>加密备份订阅、节点选择、覆写和 Sub-Store 数据。</p></div><span role="status" className="dav-save">{dirty ? '未保存' : snapshot.configured ? '已配置' : '未配置'}</span></header>
    <form onSubmit={event => { event.preventDefault(); void save(); }}><div className="dav-fields">
      <FormRow label="服务器地址" className="dav-row" control={<input className="input" type="url" aria-label="WebDAV 服务器地址" value={settings.endpoint} disabled={!!busy} placeholder="https://cloud.example/dav/" onChange={event => patch({ endpoint: event.target.value })} />} />
      <FormRow label="备份目录" className="dav-row" control={<input className="input" aria-label="WebDAV 备份目录" value={settings.directory} disabled={!!busy} onChange={event => patch({ directory: event.target.value })} />} />
      <FormRow label="账号" className="dav-row" control={<input className="input" aria-label="WebDAV 账号" autoComplete="username" value={settings.username} disabled={!!busy} onChange={event => patch({ username: event.target.value })} />} />
      <SecretField label="服务器密码" saved={snapshot.hasPassword} value={password} onChange={setPassword} busy={!!busy} /><SecretField label="备份口令" saved={snapshot.hasBackupPassphrase} value={backupPassphrase} onChange={setBackupPassphrase} busy={!!busy} />
      {identityError && <p className="dav-error" role="alert">{identityError}</p>}
      <FormRow label="本机名称" className="dav-row" control={<input className="input" aria-label="云备份本机名称" value={settings.deviceName} maxLength={80} disabled={!!busy} onChange={event => patch({ deviceName: event.target.value })} />} />
    </div><div className="dav-policy">
      <FormRow label="自动备份" className="dav-row" control={<Select ariaLabel="自动备份频率" value={settings.schedule} disabled={!!busy} options={[{ value: 'off', label: '关闭' }, { value: 'daily', label: '每天' }, { value: 'weekly', label: '每周' }]} onChange={schedule => patch({ schedule })} />} />
      <FormRow label="保留份数" hint="仅清理本设备的较旧备份" className="dav-row" control={<input className="input dav-number" aria-label="保留云备份数量" type="number" min={1} max={100} value={settings.retention} disabled={!!busy} onChange={event => patch({ retention: Number(event.target.value) })} />} />
    </div>{snapshot.credentialStore.status !== 'available' && <p className="dav-error" role="alert">系统凭据库{snapshot.credentialStore.status === 'unsupported' ? '不受支持' : '不可用'}，无法确认已保存的密码和口令。请检查系统凭据服务后重试。</p>}
    <div className="dav-actions"><button type="button" className="btn" disabled={!!busy || !!identityError || invalidSecret || !settings.endpoint.trim()} onClick={() => void test()}>测试连接</button><button className="btn btn-primary" disabled={!!busy || !dirty || !!identityError || invalidSecret}>保存设置</button></div></form>
    <div className="dav-actions"><div><strong>{status?.phase === 'running' ? '备份进行中' : status?.phase === 'error' ? '上次备份失败' : '最近备份'}<span>{when(status?.lastSuccessAt ?? null)}</span></strong><p className="dav-status">{settings.schedule === 'off' ? '自动备份已关闭' : `下次计划 ${when(status?.nextDueAt ?? null)}`}</p></div><div className="dav-inline"><button className="icon-btn" aria-label="刷新云备份任务状态" disabled={!!busy} onClick={() => void run('正在读取状态…', refreshStatus)}><IconRefresh size={14} /></button><button className="btn" disabled={!!busy || !snapshot.configured || dirty} onClick={() => setHistoryOpen(true)}>备份历史</button><button className="btn" disabled={!!busy || !snapshot.configured || dirty || status?.phase === 'running'} onClick={() => void backup()}>立即备份</button></div></div>
    {dirty && <p className="dav-status">保存设置后可备份和查看历史。</p>}
    {(error || statusMessage || statusError) && <p role="alert" className="dav-error">{error || statusMessage || statusError}</p>}{(busy || message) && <p role="status" className="dav-status">{busy || message}</p>}
    {historyOpen && <BackupHistory onClose={() => setHistoryOpen(false)} />}
  </div>;
}

function BackupHistory({ onClose }: { onClose: () => void }) {
  const title = useId(); const [history, setHistory] = useState<WebDavBackupHistory | null>(null); const [offset, setOffset] = useState(0);
  const [name, setName] = useState(''); const [passphrase, setPassphrase] = useState(''); const [preview, setPreview] = useState<WebDavBackupPreview | null>(null); const [deleting, setDeleting] = useState('');
  const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const lock = useRef(false);
  async function run(label: string, action: () => Promise<void>) { if (lock.current) return; lock.current = true; setBusy(label); setError(''); setMessage(''); try { await action(); } catch (reason) { setError(describeError(reason)); } finally { lock.current = false; setBusy(''); } }
  const load = (next = offset) => run('正在读取历史…', async () => { const result = await webdavService.history(next, 10); setHistory(result); setOffset(next); });
  useEffect(() => { void load(0); }, []);
  const restore = () => preview && run('正在恢复…', async () => { await useApp.getState().restoreBackup({ savedWebDav: true, name, passphrase, digest: preview.digest }); setMessage('备份已恢复，正在重新载入…'); window.setTimeout(() => location.reload(), 900); });
  return <Dialog labelledBy={title} busy={!!busy} onDismiss={onClose}><div className="webdav-history"><header className="dav-heading"><h3 id={title}>{deleting ? '删除云备份' : preview ? '确认恢复云备份' : name ? '解密云备份' : '云备份历史'}</h3><button className="icon-btn" aria-label="关闭备份历史" disabled={!!busy} onClick={onClose}><IconX size={16} /></button></header>
    {deleting ? <><p className="modal-desc">确定永久删除此远端备份？此操作无法撤销。</p><p className="dav-filename">{deleting}</p><div className="modal-actions"><button className="btn" disabled={!!busy} onClick={() => setDeleting('')}>取消</button><button className="btn btn-danger" disabled={!!busy} onClick={() => void run('正在删除…', async () => { await webdavService.delete(deleting); setDeleting(''); const next = history?.items.length === 1 ? Math.max(0, offset - 10) : offset; setHistory(await webdavService.history(next, 10)); setOffset(next); setMessage('备份已删除'); })}>确认删除</button></div></>
    : preview ? <><div className="dav-restore-summary"><strong>{preview.device}</strong><span>{preview.profiles} 个订阅 · {preview.collections} 个组合{'subStoreEntries' in preview && typeof preview.subStoreEntries === 'number' && ` · ${preview.subStoreEntries} 个 Sub-Store 条目`}</span></div><p className="modal-desc">将替换订阅、节点选择、覆写与 Sub-Store 内容，连接与外观沿用本机设置。恢复前会停止内核，并在本机保留当前备份。</p><div className="modal-actions"><button className="btn" disabled={!!busy} onClick={() => setPreview(null)}>返回</button><button className="btn btn-primary" disabled={!!busy} onClick={() => void restore()}>确认恢复</button></div></>
    : name ? <form onSubmit={event => { event.preventDefault(); void run('正在解密预览…', async () => setPreview(await webdavService.preview({ name, passphrase }))); }}><p className="dav-filename">{name}</p><label className="dav-unlock">此备份的口令<input className="input" type="password" autoComplete="off" aria-label="恢复云备份口令" value={passphrase} disabled={!!busy} onChange={event => setPassphrase(event.target.value)} /></label><div className="modal-actions"><button type="button" className="btn" disabled={!!busy} onClick={() => { setName(''); setPassphrase(''); }}>返回历史</button><button className="btn btn-primary" disabled={!!busy || !passphrase}>解密并预览</button></div></form>
    : <><div className="history-tools"><span className="dav-status">{history ? `${history.total} 份备份` : '读取中'}</span><button className="icon-btn" aria-label="刷新备份历史" disabled={!!busy} onClick={() => void load()}><IconRefresh size={14} /></button></div><div className="history-scroll">{history?.items.map(item => <div className="history-table-row" key={item.name}><div><strong>{item.deviceName || '设备名称未知'}{item.isCurrentDevice && <small>此设备</small>}</strong><span>{when(item.createdAt)} · {item.size == null ? '大小未知' : `${Math.ceil(item.size / 1024)} KB`}</span></div><div className="dav-inline"><button className="btn btn-sm" disabled={!!busy} onClick={() => { setName(item.name); setPassphrase(''); setError(''); }}>恢复</button><button className="btn btn-sm btn-danger" disabled={!!busy} onClick={() => setDeleting(item.name)}>删除</button></div></div>)}{history && !history.items.length && <EmptyState compact title="此目录还没有备份" />}</div>{history && history.total > 10 && <nav className="history-tools" aria-label="备份历史分页"><button className="btn btn-sm" disabled={!!busy || offset === 0} onClick={() => void load(Math.max(0, offset - 10))}>上一页</button><span>{Math.floor(offset / 10) + 1} / {Math.ceil(history.total / 10)}</span><button className="btn btn-sm" disabled={!!busy || offset + 10 >= history.total} onClick={() => void load(offset + 10)}>下一页</button></nav>}</>}
    {error && <p role="alert" className="dav-error">{error}</p>}{(busy || message) && <p role="status" className="dav-status">{busy || message}</p>}
  </div></Dialog>;
}
