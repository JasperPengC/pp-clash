import { asyncView } from './components/AsyncView';
import { useEffect, useRef, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { Sidebar, type PageKey } from './components/Sidebar';
import { useApp } from './store/app';
import type { OutboundMode, ToastKind } from './domain/app';
import { api, isTauri } from './core/api';
import { IconAlert, IconCheck, IconDownload, IconInfo, IconSettings, IconX } from './components/icons';
import { BrandCat } from './components/BrandCat';
import { WindowsTitlebar } from './components/WindowsTitlebar';
import { isLinux, isWindows } from './core/platform';
import { useWindowVisible } from './core/window-activity';
import { useBackgroundHealth } from './application/background-health';
import { startPolling } from './core/polling';
import { installRuntimeDisplayPublisher } from './core/runtime-display-events';
import { Dialog } from './components/Dialog';
import { Segmented } from './components/ui';

const OverviewPage = asyncView(() => import('./pages/Overview').then(module => ({ default: module.OverviewPage })));
const ProxiesPage = asyncView(() => import('./pages/Proxies').then(module => ({ default: module.ProxiesPage })));
const ConnectionsPage = asyncView(() => import('./pages/Connections').then(module => ({ default: module.ConnectionsPage })));
const RulesPage = asyncView(() => import('./pages/Rules').then(module => ({ default: module.RulesPage })));
const LogsPage = asyncView(() => import('./pages/Logs').then(module => ({ default: module.LogsPage })));
const OverridePage = asyncView(() => import('./pages/Override').then(module => ({ default: module.OverridePage })));
const KernelPage = asyncView(() => import('./pages/Kernel').then(module => ({ default: module.KernelPage })));
const ResourcesPage = asyncView(() => import('./pages/Resources').then(module => ({ default: module.ResourcesPage })));
const TrafficPage = asyncView(() => import('./pages/Traffic').then(module => ({ default: module.TrafficPage })));
const DnsPage = asyncView(() => import('./pages/Dns').then(module => ({ default: module.DnsPage })));
const SecurityPage = asyncView(() => import('./pages/Security').then(module => ({ default: module.SecurityPage })));
const ProfilesPage = asyncView(() => import('./pages/Profiles').then(module => ({ default: module.ProfilesPage })));
const SubStorePage = asyncView(() => import('./pages/SubStore').then(module => ({ default: module.SubStorePage })));
const SettingsPage = asyncView(() => import('./pages/Settings').then(module => ({ default: module.SettingsPage })));

const TOAST_TTL = 5000;

const PAGE_KEYS: PageKey[] = [
  'overview',
  'proxies',
  'connections',
  'security',
  'profiles',
  'substore',
  'rules',
  'logs',
  'override',
  'kernel',
  'resources',
  'traffic',
  'dns',
  'settings',
];

function initialPage(): PageKey {
  try {
    const page = new URLSearchParams(window.location.search).get('page');
    if (page && (PAGE_KEYS as string[]).includes(page)) return page as PageKey;
  } catch {
    /* ignore */
  }
  return 'overview';
}

function ToastIcon({ kind }: { kind: ToastKind }) {
  if (kind === 'success') return <IconCheck size={14} />;
  if (kind === 'error') return <IconAlert size={14} />;
  return <IconInfo size={14} />;
}

function WorkspaceToolbar({ onSettings, settingsActive }: { onSettings: () => void; settingsActive: boolean }) {
  const mode = useApp(s => s.settings.mode);
  const changeOutboundMode = useApp(s => s.changeOutboundMode);
  const [switchingMode, setSwitchingMode] = useState(false);
  const modeLock = useRef(false);
  const changeMode = async (nextMode: OutboundMode) => {
    if (nextMode === mode || modeLock.current) return;
    modeLock.current = true;
    setSwitchingMode(true);
    try {
      await changeOutboundMode(nextMode);
    } finally {
      modeLock.current = false;
      setSwitchingMode(false);
    }
  };

  return <header className="workspace-toolbar" aria-label="窗口工具栏" data-tauri-drag-region>
    <button className={`workspace-settings capsule${settingsActive ? ' active' : ''}`} type="button" aria-label="打开设置"
      aria-current={settingsActive ? 'page' : undefined} onClick={onSettings} title="设置">
      <IconSettings size={17} />
    </button>
    <Segmented ariaLabel="出站模式" disabled={switchingMode}
      options={[{ value: 'rule', label: '规则' }, { value: 'global', label: '全局' }, { value: 'direct', label: '直连' }]}
      value={mode} onChange={value => void changeMode(value)} />
  </header>;
}

export default function App() {
  const windowVisible = useWindowVisible();
  useBackgroundHealth();
  const [page, setPage] = useState<PageKey>(initialPage);
  const toast = useApp((s) => s.toast);
  const clearToast = useApp((s) => s.clearToast);
  const updateInfo = useApp((s) => s.updateInfo);
  const dismissUpdate = useApp((s) => s.dismissUpdate);
  const downloadUpdate = useApp((s) => s.downloadUpdate);
  const downloadingUpdate = useApp((s) => s.downloadingUpdate);
  const elevationPrompt = useApp((s) => s.elevationPrompt);
  const elevationBusy = useApp((s) => s.elevationBusy);
  const confirmElevation = useApp((s) => s.confirmElevation);
  const cancelElevation = useApp((s) => s.cancelElevation);

  useEffect(() => {
    if (!isTauri) return;
    return installRuntimeDisplayPublisher(() => {
      const state = useApp.getState();
      return {
        key: JSON.stringify([state.runtimeConfigRevision, state.connectedAt, state.kernelPhase, state.settings.controllerPort, state.settings.controllerSecret]),
        transitioning: state.runtimeConfigTransition || state.kernelPhase === 'starting' || state.kernelPhase === 'stopping',
      };
    }, changed => useApp.subscribe(changed));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.windowVisible = String(windowVisible);
    return () => { delete document.documentElement.dataset.windowVisible; };
  }, [windowVisible]);

  // 托盘事件 → 前端状态。托盘在窗口隐藏时也可操作，这里是唯一的回传通道。
  useEffect(() => {
    if (!isTauri) return;
    const unlisteners = [
      listen('tray://node', () => {
        useApp.setState(s => ({ routeRevision: s.routeRevision + 1 }));
        void useApp.getState().refreshGroups();
      }),
      listen<boolean>('tray://sysproxy', (e) => {
        useApp.getState().setSysProxyEnabled(e.payload);
      }),
      listen('tray://tun', () => {
        const s = useApp.getState();
        void s.setTun(!s.tunEnabled);
      }),
      listen<string>('tray://error', (e) => {
        useApp.getState().notify('error', e.payload);
      }),
      listen('tray://toggle-sysproxy', () => {
        const s = useApp.getState();
        void s.toggleSystemProxy(!s.sysProxyEnabled);
      }),
      listen('tray://toggle-tun', () => {
        const s = useApp.getState();
        void s.setTun(!s.tunEnabled);
      }),
      listen('tray://toggle-kernel', () => {
        const s = useApp.getState();
        if (s.kernelPhase === 'running') void s.stopKernel();
        else void s.startKernel();
      }),
      listen<boolean>('tray://panel-sysproxy', (e) => {
        void useApp.getState().toggleSystemProxy(e.payload);
      }),
      listen<string>('tray://panel-profile', (e) => {
        void useApp.getState().activate(e.payload);
      }),
      listen<{ id: string; request: string }>('tray://refresh-profile', (e) => {
        if (!e.payload || typeof e.payload.id !== 'string' || typeof e.payload.request !== 'string') return;
        const { id, request } = e.payload;
        void useApp.getState().refreshProfile(id, true).then(ok => emit('tray://profile-refreshed', { request, ok }))
          .catch(() => { void emit('tray://profile-refreshed', { request, ok: false }).catch(() => {}); });
      }),
      listen<{ group: string; node: string }>('tray://panel-node', (e) => {
        void useApp.getState().selectNode(e.payload.group, e.payload.node);
      }),
      listen<string>('tray://navigate', (e) => {
        const target = e.payload as PageKey;
        if (PAGE_KEYS.includes(target)) setPage(target);
      }),
      listen<string>('tray://mode', (e) => {
        const mode = e.payload as OutboundMode;
        if (['rule', 'global', 'direct'].includes(mode)) void useApp.getState().changeOutboundMode(mode);
      }),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((un) => un()));
    };
  }, []);

  // EmptyState / 引导按钮的跨页跳转
  useEffect(() => {
    const onNav = (e: Event) => {
      const target = (e as CustomEvent<string>).detail as PageKey;
      if (PAGE_KEYS.includes(target)) {
        setPage(target);
      }
    };
    window.addEventListener('ppclash:nav', onNav);
    return () => window.removeEventListener('ppclash:nav', onNav);
  }, []);

  // 侧栏版本号/关于入口点击检查更新
  useEffect(() => {
    const handle = () => void useApp.getState().checkUpdate(false);
    window.addEventListener('ppclash:check-update', handle);
    return () => window.removeEventListener('ppclash:check-update', handle);
  }, []);

  // 内核心跳：mihomo 可能自己退出（配置/端口/数据问题），
  // 前端不能一直显示「已连接」，否则用户会以为代理在跑但实际全网不通。
  useEffect(() => {
    if (!isTauri) return;
    let misses = 0;
    let alive = true;
    const stop = startPolling(async () => {
      const s = useApp.getState();
      if (s.kernelPhase !== 'running') { misses = 0; return; }
      const revision = s.routeRevision;
      try {
        const st = await api.kernelStatus(s.settings.controllerSecret);
        if (!alive || useApp.getState().routeRevision !== revision) { misses = 0; return; }
        if (st.running) { misses = 0; return; }
        // 两次串行的明确死亡报告才恢复，旧请求和异常不拼成连续失败。
        if (++misses >= 2) { misses = 0; await useApp.getState().handleKernelLost(); }
      } catch { misses = 0; }
    }, 5000);
    return () => { alive = false; stop(); };
  }, []);

  // 订阅自动更新：每 10 分钟检查一次，按机场返回的更新间隔（缺省 24h）
  useEffect(() => {
    if (!isTauri) return;
    const check = () => {
      const s = useApp.getState();
      if (!s.settings.autoUpdate) return;
      const now = Date.now();
      for (const p of s.profiles) {
        if (p.autoUpdateHours === 0) continue;
        const hours = p.autoUpdateHours ?? p.updateIntervalHours ?? 24;
        if (hours > 0 && now - p.updatedAt > hours * 3_600_000) {
          void s.refreshProfile(p.id, true);
        }
      }
    };
    const timer = window.setInterval(check, 10 * 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // 全局 toast：5 秒自动消退，点击立关
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(clearToast, TOAST_TTL);
    return () => clearTimeout(t);
  }, [toast?.id, toast, clearToast]);

  return (
    <div className={`window-shell${isWindows ? ' is-windows' : isLinux ? ' is-linux' : ''}${isTauri ? ' is-native' : ''}`} data-window-visible={windowVisible}
      onContextMenu={event => event.preventDefault()}>
      {isWindows && <WindowsTitlebar />}
      <div className="app">
      <Sidebar current={page} onChange={setPage} />
      <div className="workspace-frame">
        <WorkspaceToolbar onSettings={() => setPage('settings')} settingsActive={page === 'settings'} />
      <main className="content desktop-main">
        <div className="workspace-watermark" aria-hidden="true"><BrandCat size={560} /></div>
        {updateInfo && (
          <div className="update-banner" role="status">
            <span className="update-banner-icon">
              <IconDownload size={14} />
            </span>
            <span className="update-banner-text">
              新版本 {updateInfo.version}
              {updateInfo.notes ? ` · ${updateInfo.notes}` : ''}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void api.openExternalUrl(updateInfo.url)}
            >
              查看更新
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={downloadingUpdate}
              onClick={() => void downloadUpdate()}
            >
              {downloadingUpdate ? '下载中…' : '下载更新'}
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="关闭更新提示"
              onClick={dismissUpdate}
            >
              <IconX size={13} />
            </button>
          </div>
        )}
        {/* 概览常驻挂载：切换页面不再重置流量曲线/服务探测等状态 */}
        <div className="page-anim" style={{ display: page === 'overview' ? undefined : 'none' }}>
          <OverviewPage active={windowVisible && page === 'overview'} />
        </div>
        {page !== 'overview' && (
          <div key={page} className={`page-anim${page === 'settings' ? ' settings-page-anim' : ''}`}>
            {page === 'proxies' && <ProxiesPage active={windowVisible} />}
            {page === 'connections' && <ConnectionsPage active={windowVisible} />}
            {page === 'rules' && <RulesPage />}
            {page === 'logs' && <LogsPage active={windowVisible} />}
            {page === 'override' && <OverridePage />}
            {page === 'kernel' && <KernelPage active={windowVisible} />}
            {page === 'resources' && <ResourcesPage />}
            {page === 'traffic' && <TrafficPage active={windowVisible} />}
            {page === 'dns' && <DnsPage />}
            {page === 'security' && <SecurityPage />}
            {page === 'profiles' && <ProfilesPage />}
            {page === 'substore' && <SubStorePage />}
            {page === 'settings' && <SettingsPage />}
          </div>
        )}

          <Dialog open={elevationPrompt} labelledBy="elevation-title" describedBy="elevation-description" busy={elevationBusy} onDismiss={cancelElevation}>
              <div className="modal-title" id="elevation-title">开启 TUN 需要管理员权限</div>
              <div className="modal-desc" id="elevation-description">
                Windows 下创建虚拟网卡需要管理员权限。确认后应用会以管理员身份重启，
                重启后自动开启 TUN。
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-ghost" disabled={elevationBusy} onClick={cancelElevation}>
                  取消
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={elevationBusy}
                  onClick={() => void confirmElevation()}
                >
                  {elevationBusy ? '正在请求…' : '以管理员身份重启'}
                </button>
              </div>
          </Dialog>

        {toast && (
          <div className="toast-wrap">
            <button
              type="button"
              className={`toast ${toast.kind}`}
              onClick={clearToast}
              role="status"
              aria-live="polite"
            >
              <span className="toast-icon">
                <ToastIcon kind={toast.kind} />
              </span>
              <span style={{ userSelect: 'text' }}>{toast.text}</span>
            </button>
          </div>
        )}
      </main>
      </div>
      </div>
    </div>
  );
}
