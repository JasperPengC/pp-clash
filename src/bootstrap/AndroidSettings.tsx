import { useEffect, useState, type ReactNode } from 'react';
import { BrandCat } from '../components/BrandCat';
import { PageHeader } from '../components/PageHeader';
import { IconChevronRight, IconDownload, IconRefresh } from '../components/icons';
import { Segmented, Toggle } from '../components/ui';
import { api, isTauri } from '../core/api';
import { APP_VERSION, UPDATE_REPO } from '../core/update';
import type { ThemeMode } from '../domain/app';
import { useApp } from '../store/app';
import { WebDavBackup } from '../components/WebDavBackup';

export function AndroidSettings({ tools }: { tools: ReactNode }) {
  const settings = useApp(s => s.settings);
  const updateSettings = useApp(s => s.updateSettings);
  const checkUpdate = useApp(s => s.checkUpdate);
  const checking = useApp(s => s.checkingUpdate);
  const downloading = useApp(s => s.downloadingUpdate);
  const updateInfo = useApp(s => s.updateInfo);
  const updateError = useApp(s => s.updateError);
  const checkedAt = useApp(s => s.updateCheckedAt);
  const downloadUpdate = useApp(s => s.downloadUpdate);
  const notify = useApp(s => s.notify);
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.androidAppInfo>> | null>(null);
  const [infoError, setInfoError] = useState(false);
  const [infoAttempt, setInfoAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setInfoError(false);
    if (isTauri) void api.androidAppInfo().then(value => { if (current) setInfo(value); })
      .catch(() => { if (current) setInfoError(true); });
    return () => { current = false; };
  }, [infoAttempt]);
  const status = checking ? '正在检查…' : updateError || (updateInfo ? `可更新至 v${updateInfo.version}`
    : checkedAt ? '已是最新版本' : '从 GitHub Releases 获取更新');
  return <>
    <PageHeader title="设置" />
    <div className="android-scroll android-settings">
      <section className="android-settings-group" aria-label="外观">
        <h2>外观</h2>
        <div className="android-theme-setting">
          <Segmented<ThemeMode> ariaLabel="主题" value={settings.theme} onChange={theme => updateSettings({ theme })}
            options={[{ value: 'system', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]} />
        </div>
      </section>
      <section className="android-settings-group" aria-label="网络工具">
        <h2>网络工具</h2>
        <div className="android-settings-card android-list">{tools}</div>
      </section>
      <section className="android-settings-group" aria-label="备份与恢复">
        <h2>备份与恢复</h2><div className="android-settings-card"><WebDavBackup mobile /></div>
      </section>
      <section className="android-settings-group" aria-label="应用更新">
        <h2>应用更新</h2>
        <div className="android-settings-card">
          <div className="android-setting-row">
            <div className="android-setting-copy"><span>检查更新</span>
              <small role="status" data-error={!!updateError}>{status}</small></div>
            <button type="button" className="android-setting-action" aria-label="检查更新" disabled={checking || downloading}
              aria-busy={checking} onClick={() => void checkUpdate(true)}><IconRefresh size={18} className={checking ? 'spin' : undefined} /></button>
          </div>
          {updateInfo && <div className="android-update-offer">
            <div><strong>v{updateInfo.version}</strong><span>{downloading ? '正在下载并校验…' : updateInfo.sha256 ? '下载完成后由系统确认安装' : '发布包缺少校验信息'}</span></div>
            <button type="button" className="android-setting-action" aria-label="下载并安装更新" disabled={downloading || !updateInfo.sha256}
              aria-busy={downloading} onClick={() => void downloadUpdate()}>
              {downloading ? <span className="android-action-spinner" /> : <IconDownload size={19} />}
            </button>
            {updateInfo.notes && <details><summary>更新说明</summary><p>{updateInfo.notes}</p></details>}
          </div>}
          <div className="android-setting-row"><span>启动时检查更新</span>
            <Toggle label="启动时检查更新" on={settings.updateCheckOnLaunch} onChange={updateCheckOnLaunch => updateSettings({ updateCheckOnLaunch })} />
          </div>
        </div>
      </section>
      <section className="android-settings-group" aria-label="关于应用">
        <h2>关于应用</h2>
        <div className="android-settings-card">
          <div className="android-setting-brand"><BrandCat size={36} /><div><strong>PP Clash</strong><small>Android{info ? ` · ${info.abi}` : ''}</small></div><span>v{info?.version ?? APP_VERSION}</span></div>
          <div className="android-setting-row"><span>Mihomo 内核</span>{infoError
            ? <button type="button" className="android-setting-action" aria-label="重新读取版本信息" onClick={() => setInfoAttempt(value => value + 1)}><IconRefresh size={18} /></button>
            : <span className="android-setting-value" title={info?.kernelVersion}>{info?.kernelVersion || (isTauri ? '读取中…' : '预览模式')}</span>}</div>
          {info && <div className="android-setting-row"><span>安装版本</span><span className="android-setting-value">{info.debug ? '测试版' : '正式版'} · {info.build}</span></div>}
          <button type="button" className="android-setting-row android-settings-link" onClick={() => void api.openExternalUrl(`https://github.com/${UPDATE_REPO}/releases`)
            .catch(() => notify('error', '无法打开发布页面'))}><span>发布与更新记录</span><IconChevronRight size={16} /></button>
        </div>
        <p className="android-settings-note">PP Clash 不提供代理节点或订阅服务。</p>
      </section>
    </div>
  </>;
}
