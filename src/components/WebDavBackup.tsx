import { useId, useRef, useState } from 'react';
import { api, type WebDavBackupPreview } from '../core/api';
import { isAndroid, isLinux, isWindows } from '../core/platform';
import { useApp } from '../store/app';
import { Dialog } from './Dialog';
import { IconChevronRight, IconX } from './icons';
import './webdav-backup.css';

const PER_PAGE = 10;

function when(name: string) {
  return new Date(Number(name.split('-')[1])).toLocaleString();
}

export function WebDavBackup({ mobile = false }: { mobile?: boolean }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <button type="button" ref={trigger} className={mobile ? 'android-setting-row android-settings-link' : 'btn'}
      onClick={() => setOpen(true)}>{mobile ? <><span>WebDAV 云备份</span><IconChevronRight size={16} /></> : '管理云备份'}</button>
    {open && <BackupDialog trigger={trigger.current} onClose={() => setOpen(false)} />}
  </>;
}

function BackupDialog({ trigger, onClose }: { trigger: HTMLElement | null; onClose: () => void }) {
  const title = useId();
  const [endpoint, setEndpoint] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [device, setDevice] = useState(isAndroid ? 'Android' : isWindows ? 'Windows' : isLinux ? 'Linux' : 'Mac');
  const [files, setFiles] = useState<string[] | null>(null);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<{ name: string; preview: WebDavBackupPreview } | null>(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const lock = useRef(false);
  const connection = { endpoint: endpoint.trim(), username, password };
  async function run(label: string, action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(label);
    setError('');
    setMessage('');
    try { await action(); }
    catch (reason) { setError(String(reason)); }
    finally { lock.current = false; setBusy(''); }
  }
  const connect = () => run('正在连接…', async () => { setFiles(await api.webdavList(connection)); setPage(0); });
  const upload = () => run('正在加密上传…', async () => {
    const name = await api.webdavUpload(connection, passphrase, device.trim());
    setFiles(existing => [name, ...(existing ?? []).filter(f => f !== name)]);
    setPage(0);
    setMessage('备份已上传');
  });
  const inspect = (name: string) => run('正在读取备份…', async () => {
    const preview = await api.webdavPreview(connection, name, passphrase);
    setSelected({ name, preview });
  });
  const restore = () => selected && run('正在恢复…', async () => {
    await useApp.getState().restoreBackup({ connection, passphrase, name: selected.name, digest: selected.preview.digest });
    window.location.reload();
  });
  return <Dialog labelledBy={title} returnFocus={trigger} busy={!!busy} onDismiss={onClose}>
    <div className="webdav-backup">
      <header className="sub-editor-heading"><h3 id={title}>{selected ? '恢复云备份' : 'WebDAV 云备份'}</h3>
        <button type="button" className="icon-btn" aria-label="关闭云备份" disabled={!!busy} onClick={onClose}><IconX size={16} /></button></header>
      {selected ? <>
        <div className="webdav-summary"><strong>{selected.preview.device}</strong>
          <span>{when(selected.name)} · {selected.preview.profiles} 个订阅{selected.preview.collections > 0 && `（含 ${selected.preview.collections} 个组合）`}</span></div>
        <p>将替换订阅、节点选择和覆写。恢复前会在本机保留一份备份。</p>
        <div className="webdav-actions"><button className="btn" disabled={!!busy} onClick={() => { setSelected(null); setError(''); }}>返回</button>
          <button className="btn btn-primary" disabled={!!busy} onClick={() => void restore()}>确认恢复</button></div>
      </> : files === null ? <form onSubmit={e => { e.preventDefault(); void connect(); }}>
        <label>WebDAV 目录<input className="input" type="url" required placeholder="https://cloud.example/dav/" value={endpoint} disabled={!!busy} onChange={e => setEndpoint(e.target.value)} /></label>
        <label>账号<input className="input" autoComplete="username" value={username} disabled={!!busy} onChange={e => setUsername(e.target.value)} /></label>
        <label>服务器密码<input className="input" type="password" autoComplete="current-password" value={password} disabled={!!busy} onChange={e => setPassword(e.target.value)} /></label>
        <button className="btn btn-primary" disabled={!!busy || !endpoint.trim()}>连接目录</button>
      </form> : <>
        <div className="webdav-row"><strong>加密备份</strong><button className="btn btn-sm" disabled={!!busy} onClick={() => { setFiles(null); setPage(0); setEndpoint(''); setUsername(''); setPassword(''); setPassphrase(''); setError(''); setMessage(''); }}>更换目录</button></div>
        <label>本机名称<input className="input" value={device} maxLength={80} disabled={!!busy} onChange={e => setDevice(e.target.value)} /></label>
        <label>备份口令<input className="input" type="password" autoComplete="off" value={passphrase} disabled={!!busy} onChange={e => setPassphrase(e.target.value)} /></label>
        <p>在其他设备恢复时需要相同口令，请妥善保存。</p>
        <button className="btn btn-primary" disabled={!!busy || !passphrase.trim() || !device.trim()} onClick={() => void upload()}>备份此设备</button>
        <div className="webdav-row"><strong>远端备份</strong><button className="btn btn-sm" disabled={!!busy} onClick={() => void connect()}>刷新</button></div>
        {files.length ? <ul>{files.slice(page * PER_PAGE, (page + 1) * PER_PAGE).map(name => <li key={name}><span>{when(name)}</span>
          <button className="btn btn-sm" disabled={!!busy || !passphrase.trim()} onClick={() => void inspect(name)}>预览</button></li>)}</ul> : <p>此目录还没有 PP Clash 备份。</p>}
        {files.length > PER_PAGE && <nav className="webdav-row" aria-label="备份分页">
          <button className="btn btn-sm" disabled={!!busy || !page} onClick={() => setPage(page - 1)}>上一页</button>
          <span>{page + 1} / {Math.ceil(files.length / PER_PAGE)}</span>
          <button className="btn btn-sm" disabled={!!busy || (page + 1) * PER_PAGE >= files.length} onClick={() => setPage(page + 1)}>下一页</button>
        </nav>}
      </>}
      {error && <p role="alert">{error}</p>}
      {(busy || message) && <p role="status">{busy || message}</p>}
    </div>
  </Dialog>;
}
