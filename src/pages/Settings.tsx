import { Children, createContext, isValidElement, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { EmptyState, ReadError, Segmented, Select, Toggle } from '../components/ui';
import { IconCheck, IconSearch, IconX } from '../components/icons';
import { formatTime } from '../core/format';
import { useApp } from '../store/app';
import type { ThemeMode } from '../domain/app';
import { api, DATA_DIR, isTauri } from '../core/api';
import { isWindows } from '../core/platform';
import { APP_VERSION, UPDATE_REPO } from '../core/update';
import { TEXT_SIZES } from '../store/text-size';
import { WebDavBackup } from '../components/WebDavBackup';

const SETTINGS_CATEGORIES = ['外观', '连接与后台', '下载', '备份与恢复', '诊断与日志', '应用更新', '页面与订阅'];
const SettingsFilter = createContext({ query: '', category: '全部' });
const SEARCH_ALIASES: Record<string, string> = {
  '文字大小': '字号 字体 font size', '主题': '颜色 深色 浅色 theme',
  '开机自启': '启动 登录 startup', '关窗最小化到托盘': '后台 菜单栏 close tray',
  '保持当前出口': '稳定 节点 IP', '故障时切换备用节点': '自动切换 容错 failover',
  '备份与恢复': 'backup restore', 'GitHub 下载代理': '镜像 加速 mirror',
};
function matchesSetting(query: string, label: string, hint = '') {
  const haystack = `${label} ${hint} ${SEARCH_ALIASES[label] ?? ''}`.toLocaleLowerCase();
  return query.trim().toLocaleLowerCase().split(/\s+/).every(word => haystack.includes(word));
}

function Section({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: ReactNode;
}) {
  const { query, category } = useContext(SettingsFilter);
  if (!query && category !== '全部' && category !== title) return null;
  const matching = !query || matchesSetting(query, title, desc) ? children
    : Children.toArray(children).filter(child => isValidElement<{ label?: string; hint?: string }>(child)
      && child.type === Row && matchesSetting(query, child.props.label ?? '', child.props.hint));
  if (query && Children.count(matching) === 0) return null;
  return (
    <section className="settings-section" aria-label={title}>
      <div className="section-head">
        <div className="section-head-text">
          <h2 className="section-title">{title}</h2>
          {desc && <div className="section-desc">{desc}</div>}
        </div>
      </div>
      {matching}
    </section>
  );
}

function Row({
  label,
  hint,
  control,
  className = '',
}: {
  label: string;
  hint?: string;
  control: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={`field-row ${className}`} role="group" aria-labelledby={`${id}-label`} aria-describedby={hint ? `${id}-hint` : undefined}>
      <div className="field-main">
        <div className="field-label" id={`${id}-label`}>{label}</div>
        {hint && <div className="field-hint" id={`${id}-hint`}>{hint}</div>}
      </div>
      <div className="field-control">{control}</div>
    </div>
  );
}

const GH_PRESETS = [
  { value: 'auto', label: '自动（优先代理）' },
  { value: '', label: '直连' },
  { value: 'https://gh-proxy.org/', label: 'gh-proxy.org' },
  { value: 'https://ghfast.top/', label: 'ghfast.top' },
  { value: 'https://down.clashparty.org/', label: 'down.clashparty.org' },
  { value: 'https://download.mihomo.party/', label: 'download.mihomo.party' },
];

function customProxyDraft(value: string): string {
  if (GH_PRESETS.some(preset => preset.value === value)) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : '';
  } catch { return ''; }
}

const THEMES: Array<{ value: ThemeMode; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
];

function ThemePreviewWindow({ theme }: { theme: 'light' | 'dark' }) {
  return <span className={`settings-thumb-window is-${theme}`}>
    <span className="settings-thumb-sidebar"><i /><i /><i /></span>
    <span className="settings-thumb-content">
      <span className="settings-thumb-toolbar"><i /><i /></span>
      <span className="settings-thumb-cards"><i /><i /></span>
      <span className="settings-thumb-panel"><i /><i /><i /></span>
    </span>
  </span>;
}

function ThemePicker({ value, onChange }: { value: ThemeMode; onChange: (theme: ThemeMode) => void }) {
  return <div className="settings-theme-picker" role="group" aria-label="主题">
    {THEMES.map(option => <button key={option.value} type="button" className="settings-theme-option"
      aria-pressed={value === option.value} onClick={() => onChange(option.value)}>
      <span className={`settings-theme-thumb is-${option.value}`} aria-hidden="true">
        <ThemePreviewWindow theme={option.value === 'dark' ? 'dark' : 'light'} />
        {option.value === 'system' && <ThemePreviewWindow theme="dark" />}
      </span>
      <span className="settings-theme-caption">{option.label}<span className="settings-theme-mark" aria-hidden="true">
        {value === option.value && <IconCheck size={12} />}
      </span></span>
    </button>)}
  </div>;
}

/** 分类独立展示，搜索跨分类；表单草稿由页面保存。 */
export function SettingsPage() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('外观');
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  const checkingUpdate = useApp((s) => s.checkingUpdate);
  const checkUpdate = useApp((s) => s.checkUpdate);
  const updateInfo = useApp((s) => s.updateInfo);

  const [restoreConfirm, setRestoreConfirm] = useState<string | null>(null);
  const [backups, setBackups] = useState<
    Array<{ name: string; size: number; mtimeMs: number }>
  >([]);
  const [backupsLoading, setBackupsLoading] = useState(isTauri);
  const [backupsError, setBackupsError] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const backupLock = useRef(false);
  const backupRequest = useRef(0);
  const backupReading = useRef(false);
  const restoreTimer = useRef<number | undefined>(undefined);
  const [proxyCustomOpen, setProxyCustomOpen] = useState(false);
  const [ghDraft, setGhDraft] = useState(() => customProxyDraft(settings.githubProxy));
  const [proxySaveError, setProxySaveError] = useState<string | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const notify = useApp((s) => s.notify);

  useEffect(() => {
    const savedCustom = customProxyDraft(settings.githubProxy);
    if (savedCustom) setGhDraft(savedCustom);
  }, [settings.githubProxy]);

  const isCustomProxy =
    settings.githubProxy !== '' &&
    settings.githubProxy !== 'auto' &&
    !GH_PRESETS.some((p) => p.value === settings.githubProxy);
  const editingCustomProxy = isCustomProxy || proxyCustomOpen;
  const customProxyPending = editingCustomProxy && (!isCustomProxy || ghDraft.trim() !== settings.githubProxy);
  const proxySelectValue = editingCustomProxy ? '__custom__' : settings.githubProxy;
  const proxyOptions = [
    ...GH_PRESETS,
    { value: '__custom__', label: editingCustomProxy ? customProxyPending ? '自定义（待保存）' : '自定义' : '自定义…' },
  ];
  const saveCustomProxy = () => {
    const value = ghDraft.trim();
    if (!value || value === settings.githubProxy) return;
    setProxySaveError(null);
    try {
      updateSettings({ githubProxy: value });
      setProxyCustomOpen(false);
    } catch (error) {
      setProxySaveError(`下载代理未保存：${String(error)}，请重试`);
    }
  };

  const loadBackups = useCallback(async () => {
    if (!isTauri || backupReading.current) return;
    backupReading.current = true;
    const request = ++backupRequest.current;
    setBackupsLoading(true);
    setBackupsError(null);
    try {
      const items = await api.listBackups(DATA_DIR);
      if (request === backupRequest.current) setBackups(items);
    } catch (error) {
      if (request === backupRequest.current) setBackupsError(`备份列表读取失败：${String(error)}`);
    } finally {
      if (request === backupRequest.current) {
        backupReading.current = false;
        setBackupsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadBackups();
    return () => {
      backupRequest.current += 1;
      backupReading.current = false;
      window.clearTimeout(restoreTimer.current);
    };
  }, [loadBackups]);

  const doBackup = async () => {
    if (backupLock.current || backupReading.current) return;
    backupLock.current = true;
    setBackupBusy(true);
    setRestoreConfirm(null);
    const notify = useApp.getState().notify;
    try {
      const path = await api.backupAppState(DATA_DIR);
      notify('success', `已备份到 ${path.split(/[\\/]/).pop()}`);
      await loadBackups();
    } catch (e) {
      notify('error', `备份失败：${String(e)}`);
    } finally {
      backupLock.current = false;
      setBackupBusy(false);
    }
  };

  const doRestore = async (name: string) => {
    if (backupLock.current || backupReading.current) return;
    const notify = useApp.getState().notify;
    if (restoreConfirm !== name) {
      setRestoreConfirm(name);
      window.clearTimeout(restoreTimer.current);
      restoreTimer.current = window.setTimeout(() => setRestoreConfirm((cur) => (cur === name ? null : cur)), 3000);
      return;
    }
    backupLock.current = true;
    setBackupBusy(true);
    window.clearTimeout(restoreTimer.current);
    setRestoreConfirm(null);
    try {
      await useApp.getState().restoreBackup(name);
      notify('success', '已恢复，正在重新加载');
      window.setTimeout(() => location.reload(), 900);
    } catch (e) {
      backupLock.current = false;
      setBackupBusy(false);
      notify('error', `恢复失败：${String(e)}`);
    }
  };

  return (
    <>
      <header className="page-head">
        <div className="page-heading">
          <h1 className="page-title">设置</h1>
        </div>
        <div className="page-actions">
          <div className="settings-search">
            <IconSearch size={14} />
            <input ref={searchRef} aria-label="搜索设置" placeholder="搜索设置" value={query}
              onChange={event => { setQuery(event.target.value); if (contentRef.current) contentRef.current.scrollTop = 0; }}
              onKeyDown={event => { if (event.key === 'Escape') setQuery(''); }} />
            {query && <button type="button" className="icon-btn" aria-label="清空设置搜索"
              onClick={() => { setQuery(''); searchRef.current?.focus(); }}><IconX size={12} /></button>}
          </div>
        </div>
      </header>

      <nav className="settings-categories seg" aria-label="设置分类">
        {SETTINGS_CATEGORIES.map(item => <button key={item} type="button"
          className={`settings-category seg-btn${!query && category === item ? ' active' : ''}`} aria-pressed={!query && category === item}
          onClick={() => { setCategory(item); setQuery(''); if (contentRef.current) contentRef.current.scrollTop = 0; }}>{item}</button>)}
      </nav>
      <div className="page-scroll settings-scroll" ref={contentRef}>
        <div className="page-inner settings-workspace">
          <div className="settings-content">
          <SettingsFilter.Provider value={{ query, category }}>
          <div className={`settings-page${query ? ' searching' : ''}`}>
            <Section title="外观">
              <Row
                label="主题"
                className="settings-theme-row"
                control={<ThemePicker value={settings.theme} onChange={theme => updateSettings({ theme })} />}
              />
              <Row
                label="文字大小"
                control={<Segmented ariaLabel="文字大小" options={TEXT_SIZES} value={settings.textSize} onChange={textSize => updateSettings({ textSize })} />}
              />
            </Section>
            <Section title="连接与后台">
              <Row
                label="开机自启"
                hint="登录后启动"
                control={
                  <Toggle
                    on={settings.launchAtLogin}
                    onChange={(v) => updateSettings({ launchAtLogin: v })}
                    label="开机自启"
                  />
                }
              />
              {!isWindows && (
                <Row
                  label="关闭窗口后隐藏 Dock 图标"
                  hint={settings.closeToTray ? '在菜单栏继续运行' : '需开启关窗最小化到托盘'}
                  control={
                    <Toggle
                      on={settings.hideDockOnClose}
                      disabled={!settings.closeToTray}
                      onChange={(v) => updateSettings({ hideDockOnClose: v })}
                      label="关闭窗口后隐藏 Dock 图标"
                    />
                  }
                />
              )}
              <Row
                label="托盘实时网速"
                hint="显示上传 / 下载"
                control={
                  <Toggle
                    on={settings.traySpeed}
                    onChange={(v) => updateSettings({ traySpeed: v })}
                    label="托盘实时网速"
                  />
                }
              />
              <Row
                label="关窗最小化到托盘"
                hint="关闭此选项后，关窗会退出应用"
                control={
                  <Toggle
                    on={settings.closeToTray}
                    onChange={(v) => updateSettings({ closeToTray: v })}
                    label="关窗最小化到托盘"
                  />
                }
              />
              <Row
                label="保持当前出口"
                hint="主出口不按延迟自动切换；独立地区组和负载均衡组除外。下次连接生效。"
                control={<Toggle on={settings.stableRouting} label="保持当前出口"
                  onChange={(on) => {
                    updateSettings({ stableRouting: on });
                    notify('info', '出口策略已保存，下次连接时生效');
                  }} />}
              />
              <Row
                label="故障时切换备用节点"
                hint="每 2 分钟检查；至少两个服务连续失败 3 轮才切换，10 分钟内不再切换。单站拒绝或限流不触发。"
                control={<Toggle on={settings.autoFailover} label="故障时切换备用节点"
                  onChange={(on) => updateSettings({ autoFailover: on })} />}
              />
            </Section>

            <Section
              title="下载"
              desc="用于内核与资源下载"
            >
              <Row
                label="GitHub 下载代理"
                hint="自动模式优先使用本机代理"
                control={
                  <Select
                    value={proxySelectValue}
                    options={proxyOptions}
                    ariaLabel="GitHub 下载代理"
                    onChange={(v) => {
                      if (v === '__custom__') {
                        setProxyCustomOpen(true);
                        setProxySaveError(null);
                        return;
                      }
                      setProxySaveError(null);
                      updateSettings({ githubProxy: v });
                      setProxyCustomOpen(false);
                    }}
                  />
                }
              />
              {editingCustomProxy && (
                <Row
                  label="自定义前缀"
                  hint="下载链接前缀"
                  control={
                    <div className="settings-prefix-control"><input
                      className="input"
                      value={ghDraft}
                      onChange={(e) => { setGhDraft(e.target.value); setProxySaveError(null); }}
                      placeholder="https://your-proxy.example/"
                      spellCheck={false}
                      aria-label="自定义 GitHub 下载代理"
                      aria-describedby={proxySaveError ? 'settings-proxy-save-error' : undefined}
                    />
                    <button type="button" className="btn btn-sm" disabled={!ghDraft.trim() || ghDraft.trim() === settings.githubProxy}
                      onClick={saveCustomProxy}>保存前缀</button>
                    {proxySaveError && <p className="settings-prefix-error" id="settings-proxy-save-error" role="alert">{proxySaveError}</p>}
                    </div>
                  }
                />
              )}
            </Section>

            <Section title="备份与恢复" desc="恢复会替换订阅、覆写与应用设置；恢复前自动保留当前备份">
              <Row label="WebDAV 云备份" hint="在设备之间迁移订阅和覆写" control={<WebDavBackup />} />
              <Row
                label="立即备份"
                hint="保存到 backups/"
                control={
                  <button type="button" className="btn" disabled={backupBusy || backupsLoading} onClick={() => void doBackup()}>
                    备份
                  </button>
                }
              />
              {backupsLoading && <EmptyState compact title="正在读取备份" desc={backups.length ? '当前为上次读取的备份列表' : undefined} loading />}
              {backupsError && <ReadError message={`${backupsError}${backups.length ? '；当前为上次读取的备份列表' : ''}`} onRetry={() => void loadBackups()} busy={backupsLoading || backupBusy} />}
              {backups.slice(0, 3).map((b) => (
                <Row
                  key={b.name}
                  label={`${b.name.startsWith('state-before-') ? '恢复前 · ' : ''}${formatTime(b.mtimeMs)}`}
                  hint={`${(b.size / 1024).toFixed(1)} KB`}
                  control={
                    <button
                      type="button"
                      className={`btn btn-sm${restoreConfirm === b.name ? ' btn-danger' : ''}`}
                      disabled={backupBusy || backupsLoading}
                      onClick={() => void doRestore(b.name)}
                    >
                      {restoreConfirm === b.name ? '确认恢复' : '恢复'}
                    </button>
                  }
                />
              ))}
              {!backupsLoading && !backupsError && backups.length === 0 && (
                <EmptyState compact title="暂无备份" />
              )}
            </Section>

            <Section
              title="诊断与日志"
            >
              <Row
                label="导出诊断包"
                hint="含脱敏日志、运行状态和系统信息；不含订阅与覆写正文。分享前请检查内容"
                control={
                  <div className="row" style={{ gap: 8 }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={diagBusy}
                      onClick={() => {
                        setDiagBusy(true);
                        void api
                          .exportDiagnostics()
                          .then(async (path) => {
                            notify('success', `诊断包已导出：${path}`);
                            await api.openDataDir('PPClash/diagnostics').catch(() => null);
                          })
                          .catch((e) => notify('error', `导出诊断包失败：${String(e)}`))
                          .finally(() => setDiagBusy(false));
                      }}
                    >
                      {diagBusy ? '导出中…' : '导出诊断包'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => void api.openDataDir('PPClash').catch(() => null)}
                    >
                      打开数据目录
                    </button>
                  </div>
                }
              />
              <Row
                label="日志内容"
                hint="应用错误与内核运行记录"
                control={<span className="card-hint">app.log / kernel.log</span>}
              />
            </Section>

            <Section
              title="应用更新"
              desc="发现新版本后提示，不自动安装"
            >
              <Row
                label="当前版本"
                control={<span className="version-text">v{APP_VERSION}</span>}
              />
              <Row
                label="更新源"
                control={<span className="card-hint input-mono">{UPDATE_REPO}</span>}
              />
              <Row
                label="启动时检查"
                hint="有新版本时提示"
                control={
                  <Toggle
                    on={settings.updateCheckOnLaunch}
                    onChange={(v) => updateSettings({ updateCheckOnLaunch: v })}
                    label="启动时检查更新"
                  />
                }
              />
              <Row
                label="检查更新"
                hint={
                  updateInfo
                    ? `发现新版本 ${updateInfo.version}`
                    : checkingUpdate
                      ? '正在检查更新…'
                      : undefined
                }
                control={
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={checkingUpdate}
                    onClick={() => void checkUpdate(false)}
                  >
                    {checkingUpdate ? '检查中…' : '检查'}
                  </button>
                }
              />
            </Section>

            <Section title="页面与订阅">
              <Row
                label="显示配置与诊断页面"
                hint="规则、日志、覆写与内核管理"
                control={
                  <Toggle
                    on={settings.advancedMode}
                    onChange={(v) => updateSettings({ advancedMode: v })}
                    label="显示配置与诊断页面"
                  />
                }
              />
              <Row
                label="订阅自动更新"
                hint="各订阅单独设置"
                control={
                  <Toggle
                    on={settings.autoUpdate}
                    onChange={(v) => updateSettings({ autoUpdate: v })}
                    label="订阅自动更新"
                  />
                }
              />
            </Section>
          </div>
          {query && <div className="settings-search-empty" role="status">
            <EmptyState compact title="没有找到相关设置"
              desc="试试功能名称，例如“字号”或“备份”"
              action={<button type="button" className="btn btn-sm" onClick={() => { setQuery(''); searchRef.current?.focus(); }}>清除搜索</button>} />
          </div>}
          </SettingsFilter.Provider>

          {!query && category === '应用更新' && <div className="settings-about">
            <div className="settings-about-line">
              PP Clash · 构建 {__BUILD_TIME__.slice(0, 16).replace('T', ' ')}
            </div>
          </div>}
          </div>
        </div>
      </div>
    </>
  );
}
