import { useEffect, useId, useState } from 'react';
import { asyncView } from '../components/AsyncView';
import { BrandCat } from '../components/BrandCat';
import { MobilePageNavigation, PageHeader } from '../components/PageHeader';
import { SelectionIndicator } from '../components/SelectionIndicator';
import {
  IconActivity, IconBolt, IconChevronRight, IconDownload, IconGlobe, IconLink, IconLog, IconNodes,
  IconOverview, IconPower, IconProfiles, IconRefresh, IconRules, IconSettings, IconUpload, IconX, IconSliders, IconFolder,
} from '../components/icons';
import { Segmented } from '../components/ui';
import { LatencyRing } from '../components/visuals';
import { formatDuration, formatSpeed } from '../core/format';
import { api, isTauri } from '../core/api';
import { latencyTone } from '../core/latency';
import { useWindowVisible } from '../core/window-activity';
import type { OutboundMode } from '../domain/app';
import { useApp } from '../store/app';
import { useCurrentNodeLatency } from './use-current-node-latency';
import { AndroidSettings } from './AndroidSettings';
import './android-window.css';
import './android-controls.css';

const Profiles = asyncView(() => import('../pages/Profiles').then(m => ({ default: m.ProfilesPage })));
const Proxies = asyncView(() => import('../pages/Proxies').then(m => ({ default: m.ProxiesPage })));
const Connections = asyncView(() => import('../pages/Connections').then(m => ({ default: m.ConnectionsPage })));
const Rules = asyncView(() => import('../pages/Rules').then(m => ({ default: m.RulesPage })));
const Logs = asyncView(() => import('../pages/Logs').then(m => ({ default: m.LogsPage })));
const Dns = asyncView(() => import('../pages/Dns').then(m => ({ default: m.DnsPage })));
const Traffic = asyncView(() => import('../pages/Traffic').then(m => ({ default: m.TrafficPage })));
const SubStore = asyncView(() => import('../pages/SubStore').then(m => ({ default: m.SubStorePage })));
const Override = asyncView(() => import('../pages/Override').then(m => ({ default: m.OverridePage })));
const Resources = asyncView(() => import('../pages/Resources').then(m => ({ default: m.ResourcesPage })));

void useApp.getState().hydrate();
if (import.meta.env.DEV) void import('../dev/preview').then(m => m.applyPreviewIfRequested());

const tabs = [
  { id: 'overview', label: '概览', Icon: IconOverview },
  { id: 'proxies', label: '节点', Icon: IconNodes },
  { id: 'profiles', label: '订阅', Icon: IconProfiles },
  { id: 'connections', label: '连接', Icon: IconLink },
  { id: 'more', label: '更多', Icon: IconSettings },
] as const;

const morePages = [
  { id: 'sub-store', label: 'Sub-Store', Icon: IconProfiles },
  { id: 'override', label: '覆写配置', Icon: IconSliders },
  { id: 'resources', label: '资源管理', Icon: IconFolder },
  { id: 'traffic', label: '流量统计', Icon: IconActivity },
  { id: 'rules', label: '分流规则', Icon: IconRules },
  { id: 'dns', label: 'DNS 配置', Icon: IconGlobe },
  { id: 'logs', label: '运行日志', Icon: IconLog },
] as const;

type Page = typeof tabs[number]['id'] | typeof morePages[number]['id'];

declare global {
  interface Window { ppclashAndroidBack?: () => boolean }
}

function mobilePage(): Page {
  const value = window.history.state?.ppclashPage;
  return [...tabs, ...morePages].find(item => item.id === value)?.id ?? 'overview';
}

function MobileOverview({ navigate, latency }: { navigate: (page: Page) => void; latency: ReturnType<typeof useCurrentNodeLatency> }) {
  const phase = useApp(s => s.kernelPhase);
  const kernelError = useApp(s => s.kernelError);
  const loading = useApp(s => s.persistenceFrozen);
  const profiles = useApp(s => s.profiles);
  const activeId = useApp(s => s.activeId);
  const connectedAt = useApp(s => s.connectedAt);
  const refreshingIds = useApp(s => s.refreshingIds);
  const settings = useApp(s => s.settings);
  const mode = settings.mode;
  const changeMode = useApp(s => s.changeOutboundMode);
  const setTun = useApp(s => s.setTun);
  const refreshProfile = useApp(s => s.refreshProfile);
  const [pending, setPending] = useState<'starting' | 'stopping' | null>(null);
  const [modePending, setModePending] = useState(false);
  const { group: currentGroup, node: currentNode, terminal, canTest: canTestNode, testing: testingNode, delay, failed, measure: testCurrentNode } = latency;
  const [now, setNow] = useState(() => Date.now());
  const visible = useWindowVisible();
  const online = phase === 'running';
  const profile = profiles.find(p => p.id === activeId);
  const busy = pending !== null || phase === 'starting' || phase === 'stopping';
  const powerState = pending ?? (phase === 'starting' || phase === 'stopping' ? phase
    : phase === 'failed' ? 'error' : online ? 'connected' : 'idle');
  const status = { starting: '正在连接', stopping: '正在断开', connected: '已连接', error: '连接异常', idle: '未连接' }[powerState];
  const delayTone = latencyTone(delay);

  useEffect(() => {
    if (!online || !connectedAt || !visible) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [online, connectedAt, visible]);

  async function toggleVpn() {
    setPending(online ? 'stopping' : 'starting');
    try { await setTun(!online); }
    finally { setPending(null); }
  }

  async function selectMode(value: OutboundMode) {
    setModePending(true);
    try { await changeMode(value); }
    finally { setModePending(false); }
  }

  return <>
    <PageHeader title="概览">
      <button type="button" className="android-header-action" aria-label="打开设置" title="设置" onClick={() => navigate('more')}>
        <IconSettings size={18} />
      </button>
    </PageHeader>
    <div className="android-scroll android-overview">
      <div className="android-mode-row">
        <Segmented ariaLabel="出站模式" value={mode} disabled={busy || modePending}
          options={[{ value: 'rule', label: '规则' }, { value: 'global', label: '全局' }, { value: 'direct', label: '直连' }]}
          onChange={value => void selectMode(value)} />
      </div>
      <section className="android-connection-card" aria-label="当前连接">
        <div className="android-connection-copy">
          <div className="android-connection-state" data-online={online}>
            <i />{busy ? status : online ? '已连接' : phase === 'failed' ? '连接异常' : '未连接'}
          </div>
          <span className="android-connection-uptime">{online && connectedAt ? `运行 ${formatDuration(now - connectedAt)}` : profile?.name ?? '添加订阅以开始'}</span>
        </div>
        <button type="button" className="android-latency-button" data-tone={delayTone}
          title="测速当前节点" aria-label={delay === null ? '测速当前节点' : `测速当前节点，延迟 ${delay} 毫秒`} aria-busy={testingNode}
          disabled={!canTestNode || testingNode} onClick={() => void testCurrentNode()}>
          <LatencyRing ms={delay} reading={terminal ? currentNode === 'DIRECT' ? '直连' : '拒绝' : delay === null ? failed ? '失败' : '未测' : undefined}
            busy={testingNode} size={58} />
        </button>
        <div className="android-node-block">
          <div className="android-node-row">
            <button type="button" className="android-current-node" aria-label="选择当前节点" onClick={() => navigate('proxies')}>
              <span className="android-node-info">
                <span className="android-node-meta">当前节点{currentGroup && mode !== 'direct' ? ` · ${currentGroup.name}` : ''}</span>
                <strong>{terminal ? currentNode === 'DIRECT' ? '直连模式' : '拒绝连接' : currentNode || '连接后显示节点'}</strong>
              </span>
              <IconChevronRight size={15} />
            </button>
            <div className="android-node-actions">
            <button type="button" title="测速当前节点" aria-label="测速当前节点" disabled={!canTestNode || testingNode}
              aria-busy={testingNode} onClick={() => void testCurrentNode()}>
              {testingNode ? <span className="android-action-spinner" aria-hidden="true" /> : <IconBolt size={17} />}
            </button>
            <button type="button" title={refreshingIds.includes(activeId ?? '') ? '正在更新订阅' : '更新当前订阅'}
              aria-label="更新当前订阅" disabled={!activeId || refreshingIds.includes(activeId)}
              aria-busy={!!activeId && refreshingIds.includes(activeId)}
              onClick={() => activeId && void refreshProfile(activeId)}>
              <IconRefresh size={17} className={activeId && refreshingIds.includes(activeId) ? 'spin' : undefined} />
            </button>
            </div>
          </div>
        </div>
        {kernelError && <p className="android-vpn-error" role="status">{kernelError}</p>}
      </section>
      <MobileRates />
      <section className="android-switch-zone" aria-label="VPN 连接开关" data-state={powerState}>
        <button className="android-power" type="button" aria-label={online ? '断开 VPN' : '连接 VPN'}
          aria-pressed={online} aria-busy={busy} disabled={busy || (isTauri && loading)}
          onClick={() => profile ? void toggleVpn() : navigate('profiles')}>
          <span className="android-power-glyph" key={powerState} aria-hidden="true">
            {busy ? <span className="android-action-spinner" /> : <IconPower size={30} />}
          </span>
        </button>
        <span
          role="status"
          data-state={powerState}
        ><span key={powerState}>{status}</span></span>
      </section>
    </div>
  </>;
}

function MobileRates() {
  const gradientId = useId().replace(/:/g, '');
  const [rates, setRates] = useState<[number, number]>([0, 0]);
  const [samples, setSamples] = useState<[number[], number[]]>([[], []]);
  const online = useApp(s => s.kernelPhase === 'running');
  const visible = useWindowVisible();
  useEffect(() => {
    if (!online) {
      setRates([0, 0]);
      setSamples([[], []]);
      return;
    }
    if (!visible) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function sample() {
      const current = await api.trafficRates().catch(() => null);
      if (disposed) return;
      if (current) {
        setRates(current);
        setSamples(([up, down]) => [[...up, current[0]].slice(-32), [...down, current[1]].slice(-32)]);
      }
      timer = setTimeout(() => void sample(), 1000);
    }
    void sample();
    return () => { disposed = true; clearTimeout(timer); };
  }, [online, visible]);

  const max = Math.max(1, ...samples[0], ...samples[1]);
  const chartPoints = (values: number[]) => {
    const points = [...Array(Math.max(0, 32 - values.length)).fill(0), ...values];
    return points.map((value, index) => {
      const x = (index / 31) * 268;
      const y = 72 - (value / max) * 56;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  };
  const downloadPoints = chartPoints(online ? samples[1] : []);
  const [axisValue, axisUnit] = formatSpeed(max).split(' ');
  return <section className="android-rates" aria-label="实时流量">
    <div className="android-rate-grid">
      <div className="android-rate" aria-label="下载速率">
        <div className="android-rate-label"><IconDownload size={13} />下载</div>
        <strong>{formatSpeed(online ? rates[1] : 0)}</strong>
      </div>
      <div className="android-rate" aria-label="上传速率">
        <div className="android-rate-label"><IconUpload size={13} />上传</div>
        <strong>{formatSpeed(online ? rates[0] : 0)}</strong>
      </div>
    </div>
    <div className="android-rate-chart-wrap">
    <svg className="android-rate-chart" viewBox="0 0 268 84" preserveAspectRatio="none" aria-label="最近 32 秒流量变化" role="img">
      <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="var(--down-chart)" stopOpacity=".2" />
        <stop offset="1" stopColor="var(--down-chart)" stopOpacity="0" />
      </linearGradient></defs>
      <path className="android-chart-grid" d="M0 16H268M0 44H268M0 72H268" />
      <polygon points={`0,72 ${downloadPoints} 268,72`} fill={`url(#${gradientId})`} />
      <polyline className="android-chart-down" points={downloadPoints} />
      <polyline className="android-chart-up" points={chartPoints(online ? samples[0] : [])} />
    </svg>
    <div className="android-chart-axis" aria-hidden="true">
      <span>{axisValue}<small>{axisUnit}</small></span>
      <span>0</span>
    </div>
    <span className="android-chart-time">32 秒前</span>
    </div>
  </section>;
}

function More({ navigate }: { navigate: (page: Page) => void }) {
  return <AndroidSettings tools={morePages.map(({ id, label, Icon }) => <button type="button" key={id} onClick={() => navigate(id)}>
          <Icon size={20} /><span>{label}</span><IconChevronRight size={16} />
        </button>)} />;
}

export default function AndroidWindow() {
  const latency = useCurrentNodeLatency();
  const [page, setPage] = useState<Page>(mobilePage);
  const [imeHeight, setImeHeight] = useState(0);
  const active = useWindowVisible();
  const toast = useApp(s => s.toast);
  const clearToast = useApp(s => s.clearToast);

  useEffect(() => {
    if (!isTauri) return;
    const apply = () => void api.androidSystemTheme(document.documentElement.dataset.theme === 'light').catch(() => {});
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    apply();
    return () => observer.disconnect();
  }, []);

  function goBack() {
    const current = mobilePage();
    if (current === 'overview') return false;
    // 主导航是同级入口，返回按层级退出，不回放用户切换过的标签。
    const parent: Page = morePages.some(item => item.id === current) ? 'more' : 'overview';
    window.history.replaceState({ ...window.history.state, ppclashPage: parent }, '');
    setPage(parent);
    return true;
  }

  useEffect(() => {
    const restore = () => setPage(mobilePage());
    const open = (event: Event) => {
      const requested = (event as CustomEvent<unknown>).detail;
      const target = requested === 'settings' ? 'more' : requested;
      const item = [...tabs, ...morePages].find(item => item.id === target);
      if (item) navigate(item.id);
    };
    window.addEventListener('popstate', restore);
    window.addEventListener('ppclash:nav', open);
    window.ppclashAndroidBack = () => {
      if (document.querySelector('[aria-modal="true"], [aria-expanded="true"][aria-haspopup]')) {
        (document.activeElement ?? document).dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', bubbles: true, cancelable: true,
        }));
        return true;
      }
      return goBack();
    };
    return () => {
      window.removeEventListener('popstate', restore);
      window.removeEventListener('ppclash:nav', open);
      delete window.ppclashAndroidBack;
    };
  }, []);

  useEffect(() => {
    const onIme = (event: Event) => {
      const bottom = (event as CustomEvent<{ bottom?: number }>).detail?.bottom;
      const height = Number.isFinite(bottom) ? Math.max(0, Math.min(1000, Math.round(bottom!))) : 0;
      document.documentElement.style.setProperty('--android-ime-height', `${height}px`);
      document.documentElement.toggleAttribute('data-ime-open', height > 0);
      setImeHeight(height);
    };
    window.addEventListener('ppclash-ime', onIme);
    return () => {
      window.removeEventListener('ppclash-ime', onIme);
      document.documentElement.style.removeProperty('--android-ime-height');
      document.documentElement.removeAttribute('data-ime-open');
    };
  }, []);

  const connected = useApp(s => s.kernelPhase === 'running');
  useEffect(() => {
    if (!isTauri || !active || !connected) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function sample() {
      const changed = await useApp.getState().syncAndroidVpn(() => !disposed);
      if (!disposed && !changed) timer = setTimeout(() => void sample(), 2000);
    }
    void sample();
    return () => { disposed = true; clearTimeout(timer); };
  }, [active, connected]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(clearToast, 5000);
    return () => window.clearTimeout(timer);
  }, [toast, clearToast]);

  function navigate(next: Page) {
    if (next === mobilePage()) return;
    window.history.replaceState({ ...window.history.state, ppclashPage: next }, '');
    setPage(next);
  }

  const selectedTab = tabs.some(tab => tab.id === page) ? page : 'more';
  return <div className="android-shell" data-ime-open={imeHeight > 0 || undefined}>
    <div className="android-wallpaper" aria-hidden="true"><BrandCat size={460} /></div>
    <MobilePageNavigation.Provider value={{ back: morePages.some(item => item.id === page) ? goBack : undefined }}>
    <main className="android-main" data-page={page} key={page}>
      {page === 'overview' && <MobileOverview navigate={navigate} latency={latency} />}
      {page === 'proxies' && <Proxies active={active} />}
      {page === 'profiles' && <Profiles />}
      {page === 'connections' && <Connections active={active} />}
      {page === 'more' && <More navigate={navigate} />}
      {page === 'traffic' && <Traffic active={active} />}
      {page === 'rules' && <Rules />}
      {page === 'dns' && <Dns />}
      {page === 'logs' && <Logs active={active} />}
      {page === 'sub-store' && <SubStore />}
      {page === 'override' && <Override />}
      {page === 'resources' && <Resources />}
    </main>
    </MobilePageNavigation.Provider>
    <nav className="android-nav selection-track" aria-label="主导航">
      <SelectionIndicator value={selectedTab} />
      {tabs.map(({ id, label, Icon }) => <button type="button" key={id}
        aria-current={id === selectedTab ? 'page' : undefined} onClick={() => navigate(id)}>
        <span className="android-nav-icon"><Icon size={20} /></span><span className="android-nav-label">{label}</span>
      </button>)}
    </nav>
    {toast && <div className="android-toast" data-kind={toast.kind} role="status">
      <span>{toast.text}</span>
      <button type="button" aria-label="关闭提示" onClick={clearToast}><IconX size={18} /></button>
    </div>}
  </div>;
}
