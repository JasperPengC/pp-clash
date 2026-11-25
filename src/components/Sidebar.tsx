import type { ReactNode } from 'react';
import { useApp } from '../store/app';
import { VersionBadge } from './VersionBadge';
import { useKernelVersion } from '../core/use-kernel-version';
import { BrandCat } from './BrandCat';
import {
  IconActivity,
  IconChip,
  IconSliders,
  IconFolder,
  IconGlobe,
  IconLink,
  IconLog,
  IconNodes,
  IconOverview,
  IconProfiles,
  IconRules,
  IconSecurity,
  IconSettings,
} from './icons';

export type PageKey =
  | 'overview'
  | 'proxies'
  | 'connections'
  | 'profiles'
  | 'substore'
  | 'security'
  | 'rules'
  | 'logs'
  | 'override'
  | 'kernel'
  | 'resources'
  | 'traffic'
  | 'dns'
  | 'settings';

const ICONS: Record<PageKey, ReactNode> = {
  overview: <IconOverview />,
  proxies: <IconNodes />,
  connections: <IconLink />,
  security: <IconSecurity />,
  profiles: <IconProfiles />,
  substore: <IconSliders />,
  rules: <IconRules />,
  logs: <IconLog />,
  override: <IconSliders />,
  kernel: <IconChip />,
  resources: <IconFolder />,
  traffic: <IconActivity />,
  dns: <IconGlobe />,
  settings: <IconSettings />,
};

const LABELS: Record<PageKey, string> = {
  overview: '概览',
  proxies: '代理节点',
  connections: '活动连接',
  security: '安全防护',
  profiles: '订阅管理',
  substore: 'Sub-Store',
  rules: '分流规则',
  logs: '运行日志',
  override: '配置覆写',
  kernel: '内核管理',
  resources: '资源管理',
  traffic: '流量统计',
  dns: 'DNS 配置',
  settings: '设置',
};

const DAILY_ORDER: PageKey[] = ['overview', 'proxies', 'profiles', 'substore'];
const NETWORK_ORDER: PageKey[] = ['connections', 'traffic', 'logs'];
const CONFIG_ORDER: PageKey[] = ['rules', 'dns', 'security', 'override', 'resources', 'kernel'];

export function Sidebar({
  current,
  onChange,
}: {
  current: PageKey;
  onChange: (p: PageKey) => void;
}) {
  const advancedMode = useApp((s) => s.settings.advancedMode);
  const profileCount = useApp(s => s.profiles.length);
  const kernelPhase = useApp(s => s.kernelPhase);
  const sysProxyEnabled = useApp(s => s.sysProxyEnabled);
  const tunEnabled = useApp(s => s.tunEnabled);
  const kernelPath = useApp(s => s.settings.kernelPath);
  const connectedAt = useApp(s => s.connectedAt);
  const version = useKernelVersion(kernelPhase, kernelPath, connectedAt);
  const running = kernelPhase === 'running';
  const status = running ? '运行中' : kernelPhase === 'failed' ? '异常'
    : kernelPhase === 'starting' ? '启动中' : kernelPhase === 'stopping' ? '停止中' : '未运行';
  const mode = running ? tunEnabled ? 'TUN' : sysProxyEnabled ? 'PROXY' : '未接管' : status;
  const takeover = sysProxyEnabled && tunEnabled ? '系统代理与 TUN 已开启'
    : tunEnabled ? 'TUN 模式已开启' : sysProxyEnabled ? '系统代理已开启' : '未接管系统流量';
  const detail = running ? takeover : kernelPhase === 'failed' ? '查看错误详情'
    : kernelPhase === 'starting' ? '正在准备连接' : kernelPhase === 'stopping' ? '正在停止内核' : '接管未开启';
  const renderItem = (page: PageKey) => (
    <button
      key={page}
      type="button"
      className={`nav-item${current === page ? ' active' : ''}`}
      onClick={() => onChange(page)}
      aria-current={current === page ? 'page' : undefined}
    >
      <span className="nav-icon" aria-hidden="true">{ICONS[page]}</span>
      <span className="nav-label">{LABELS[page]}</span>
      {page === 'profiles' && profileCount > 0 && <span className="nav-count">{profileCount}</span>}
    </button>
  );

  return (
    <aside className="sidebar">
      <div className="titlebar sidebar-window-chrome" data-tauri-drag-region aria-hidden="true" />

      <div className="sidebar-brand">
        <BrandCat size={48} className="brand-cat" />
        <div className="sidebar-brand-copy">
          <span className="brand-name">PP Clash</span>
          <VersionBadge className="brand-version" />
        </div>
      </div>

      <div className="sidebar-scroll">
        <div className="sidebar-group-title">代理与订阅</div>
        <nav className="sidebar-nav" aria-label="主导航">{DAILY_ORDER.map(renderItem)}</nav>
        <div className="sidebar-group-title">网络观察</div>
        <nav className="sidebar-nav" aria-label="网络观察">{(advancedMode ? NETWORK_ORDER : ['connections'] as PageKey[]).map(renderItem)}</nav>
        <div className="sidebar-group-title">配置管理</div>
        <nav className="sidebar-nav" aria-label="配置管理">{(advancedMode ? CONFIG_ORDER : ['security'] as PageKey[]).map(renderItem)}</nav>
      </div>
      <div className="sidebar-foot">
        <div className="sidebar-runtime" data-phase={kernelPhase}>
          <button type="button" className="sidebar-runtime-main" onClick={() => onChange('kernel')}
            aria-label={`查看 mihomo 内核，${status}，${detail}`} title={`mihomo · ${status} · ${detail}`}>
            <span className="sidebar-runtime-mode" data-on={running && (tunEnabled || sysProxyEnabled)}>
              <span>{mode}</span><i aria-hidden="true" />
            </span>
            <span className="sidebar-runtime-heading"><strong>mihomo</strong>
              <small className="sidebar-runtime-version" aria-label={`${running ? '运行内核版本' : '已选内核版本'} ${version.label}`}
                title={version.full ?? '未确认内核版本'}>{version.label}</small>
            </span>
          </button>
        </div>
      </div>
    </aside>
  );
}
