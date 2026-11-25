import { Dialog } from '../Dialog';
import { IconX } from '../icons';
import { FormRow, Select } from '../ui';
import { JsonFields } from './EntryEditor';
import type { Data } from './model';

export function BackendSettingsDialog({ value, onChange, busy, dirty, valid, onValidity, onSave, onClose, error, message }: {
  value: Data; onChange: (value: Data) => void; busy: boolean; dirty: boolean; valid: boolean;
  onValidity: (valid: boolean) => void; onSave: () => void; onClose: () => void; error: string; message: string;
}) {
  const gitlab = value.syncPlatform === 'gitlab';
  return <Dialog labelledBy="ss-settings-title" busy={busy} onDismiss={onClose}>
    <div className="ss-settings-dialog">
      <header className="ss-editor-heading"><h3 id="ss-settings-title">Sub-Store 后端设置</h3>
        <button type="button" className="icon-btn" aria-label="关闭后端设置" disabled={busy} onClick={onClose}><IconX size={16} /></button>
      </header>
      <div className="ss-settings-scroll">
        <p className="modal-desc">用于上传 Sub-Store 同步文件。</p>
        <div className="ss-backend-settings">
          <FormRow label="同步平台" control={<Select ariaLabel="同步平台" value={String(value.syncPlatform || 'gist')} disabled={busy}
            options={[{ value: 'gist', label: 'GitHub Gist' }, { value: 'gitlab', label: 'GitLab Snippet' }]}
            onChange={syncPlatform => onChange({ ...value, syncPlatform })} />} />
          <FormRow label={gitlab ? 'GitLab 用户名' : 'GitHub 用户名'} control={<input className="input" aria-label="GitHub / GitLab 用户名" disabled={busy}
            value={String(value.githubUser ?? '')} onChange={event => onChange({ ...value, githubUser: event.target.value })} />} />
          <FormRow label="同步 Token" control={<input className="input" type="password" autoComplete="off" aria-label="同步 Token" disabled={busy}
            value={String(value.gistToken ?? '')} onChange={event => onChange({ ...value, gistToken: event.target.value })} />} />
          <details className="disclosure"><summary>高级参数（JSON）</summary>
            <JsonFields value={value} busy={busy} onChange={onChange} onValidity={onValidity} />
          </details>
        </div>
      </div>
      {error && <p className="ss-error" role="alert">{error}</p>}{message && <p className="ss-hint" role="status">{message}</p>}
      <footer className="modal-actions"><button type="button" className="btn" disabled={busy} onClick={onClose}>关闭</button>
        <button type="button" className="btn btn-primary" disabled={busy || !valid || !dirty} onClick={onSave}>保存设置</button>
      </footer>
    </div>
  </Dialog>;
}
