import { invoke } from '@tauri-apps/api/core';
import { DEFAULT_LATENCY_URL, GITHUB_LATENCY_URL } from './latency';
import type { TrafficInfo } from './subscription';

/** 是否运行在 Tauri 里。浏览器里跑（纯前端预览）时用 mock，避免 invoke 直接抛错。 */
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** 当前 mihomo 控制端口；由应用 hydrate/设置变更时更新，避免 Windows 自定义端口仍打到 9090。 */
let mihomoBase = 'http://127.0.0.1:9090';
let mihomoSecret = '';

export function setMihomoBase(port: number) {
  mihomoBase = `http://127.0.0.1:${port}`;
}

export function setMihomoSecret(secret: string) {
  mihomoSecret = secret;
}

/**
 * 设计预览模式：`npm run dev` 后访问 `/?preview=connected`。
 * 只在开发构建里生效，生产构建中被静态剔除；用于在没有内核的环境下检查「已连接」态 UI。
 */
export const previewMode =
  !isTauri &&
  import.meta.env.DEV &&
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).has('preview');

export interface KernelStatus {
  running: boolean;
  pid: number | null;
  /** 启动前自动关闭的端口占用进程 pid。 */
  reclaimed?: number[];
}

export interface WebDavConnection { endpoint: string; username: string; password: string }
export interface WebDavBackupPreview { device: string; profiles: number; digest: string }
export interface WebDavRestore { connection: WebDavConnection; name: string; digest: string; passphrase: string }

export interface TrayNode {
  name: string;
  delay: number | null;
  selected: boolean;
}

export interface TrayGroup {
  name: string;
  type: string;
  now: string | null;
  manual: boolean;
  total: number;
  nodes: TrayNode[];
}

export type TrayActionValue = string | { group: string; node: string };

export interface ServiceProbe {
  id?: string;
  ok: boolean;
  latency_ms: number | null;
  status?: 'reachable' | 'unreachable' | 'error';
  detail?: string | null;
}

export interface TrayProfile {
  id: string;
  name: string;
  userinfo?: TrafficInfo | null;
  updatedAt?: number | null;
  sourceType?: 'url' | 'file' | null;
}

export interface TraySnapshot {
  running: boolean;
  sysProxy: boolean;
  tun: boolean;
  mode: string;
  node: string | null;
  group: string | null;
  up: number;
  down: number;
  showSpeed: boolean;
  controllerPort: number;
  controllerSecret: string;
  nodes: TrayNode[];
  /** 旧版本快照缺少组类型时，只提供只读浏览。 */
  groups?: TrayGroup[];
  groupsError?: string | null;
  profiles: TrayProfile[];
  activeProfile: string | null;
}

export interface HelperInfo {
  installed: boolean;
  version: string | null;
  needsUpdate: boolean;
  path: string;
}

export interface AppUpdateInfo {
  version: string;
  notes: string | null;
  url: string;
  sha256: string | null;
}

export interface KernelReleaseInfo {
  version: string;
  publishedAt: string | null;
}

export interface KernelVersionInfo {
  name: string;
  version: string;
  path: string;
  builtin: boolean;
  size: number;
}

export interface KernelInfo {
  running: boolean;
  version: string | null;
  pid: number | null;
  rssKb: number | null;
  binary: string | null;
  bundledVersion: string | null;
}

export interface SysProxyState {
  enabled: boolean;
  host: string;
  port: number;
}

/** 订阅拉取结果：原文 + 响应头里的元信息（名字 / 流量 / 更新间隔）。 */
export interface SubscriptionPayload {
  raw: string;
  profileTitle: string | null;
  contentDisposition: string | null;
  subscriptionUserinfo: string | null;
  profileUpdateInterval: string | null;
}

// 预览用的假数据：只服务界面调试，不进生产包
const PREVIEW_NODES = [
  { name: '🇯🇵 东京 01 · IPLC', type: 'Trojan', delay: 42 },
  { name: '🇯🇵 东京 02', type: 'Trojan', delay: 68 },
  { name: '🇭🇰 香港 01 · 中转', type: 'VLESS', delay: 36 },
  { name: '🇭🇰 香港 02', type: 'VLESS', delay: 55 },
  { name: '🇸🇬 新加坡 01', type: 'Hysteria2', delay: 96 },
  { name: '🇺🇸 洛杉矶 01', type: 'Shadowsocks', delay: 168 },
  { name: '🇺🇸 西雅图 01', type: 'Shadowsocks', delay: 212 },
  { name: '🇩🇪 法兰克福 01', type: 'Trojan', delay: 306 },
];

function previewProxiesJson(): string {
  const proxies: Record<string, unknown> = {};
  for (const n of PREVIEW_NODES) {
    proxies[n.name] = {
      type: n.type,
      history: [{ delay: n.delay, time: new Date().toISOString() }],
      extra: { [DEFAULT_LATENCY_URL]: { Alive: true, History: [{ delay: n.delay }] }, [GITHUB_LATENCY_URL]: { Alive: true, History: [{ delay: n.delay + 20 }] } },
    };
  }
  proxies['🚀 节点选择'] = {
    type: 'Selector',
    now: PREVIEW_NODES[0].name,
    all: PREVIEW_NODES.map((n) => n.name),
  };
  proxies['♻️ 自动选择'] = {
    type: 'URLTest',
    now: PREVIEW_NODES[2].name,
    all: PREVIEW_NODES.slice(0, 4).map((n) => n.name),
  };
  proxies['🌍 国外媒体'] = {
    type: 'Selector',
    now: PREVIEW_NODES[1].name,
    all: PREVIEW_NODES.slice(0, 6).map((n) => n.name),
  };
  return JSON.stringify({ proxies });
}

let previewT0 = Date.now();
let previewTick = 0;

// 开发态压力样本：保持稳定引用，不向生产数据写入，也不在每次轮询重新生成。
const largePreview = previewMode && new URLSearchParams(window.location.search).get('fixtures') === 'large';
const largePreviewRules = largePreview ? Array.from({ length: 10000 }, (_, i) => ({ type: 'Domain', payload: `effective-${i}.invalid`, proxy: 'DIRECT' })) : [];
const largePreviewConnections = largePreview ? Array.from({ length: 10000 }, (_, i) => ({
  id: `large-${i}`, upload: i * 2048, download: i * 8192, start: new Date(1800000000000 - i * 1000).toISOString(),
  chains: ['DIRECT'], rule: 'Domain', rulePayload: `site-${i}.invalid`,
  metadata: { network: 'tcp', host: `host-${i}.invalid`, destinationPort: 443, process: i < 8000 ? 'Browser' : `Process ${i}` },
})) : [];

function previewMihomo(method: string, path: string): unknown {
  if (method === 'GET' && (path === '/providers/rules' || path === '/providers/proxies')) {
    return { providers: {} };
  }
  if (path === '/configs' && method === 'GET') {
    return { 'mixed-port': 7890, tun: { enable: true, device: 'utun7', stack: 'mixed' } };
  }
  if (largePreview && path === '/rules') return { rules: largePreviewRules };
  if (largePreview && method === 'GET' && path === '/connections') return { connections: largePreviewConnections, uploadTotal: 20480000, downloadTotal: 81920000 };
  if (path.startsWith('/rules')) {
    return {
      rules: [
        { type: 'DOMAIN-KEYWORD', payload: 'stun', proxy: 'REJECT-DROP' },
        { type: 'DST-PORT', payload: '3478-3479', proxy: 'REJECT-DROP' },
        { type: 'AND', payload: '((NETWORK,UDP),(DST-PORT,443))', proxy: 'REJECT-DROP' },
        { type: 'DOMAIN-SUFFIX', payload: 'youtube.com', proxy: '🌍 国外媒体' },
        { type: 'DOMAIN-SUFFIX', payload: 'github.com', proxy: '🚀 节点选择' },
        { type: 'DOMAIN-KEYWORD', payload: 'google', proxy: '🚀 节点选择' },
        { type: 'GEOIP', payload: 'CN', proxy: 'DIRECT' },
        { type: 'DOMAIN-SUFFIX', payload: 'apple.com', proxy: 'DIRECT' },
        { type: 'MATCH', payload: '', proxy: '🚀 节点选择' },
      ],
    };
  }
  if (path.startsWith('/connections') && method === 'GET') {
    previewTick += 1;
    const elapsed = Math.max(1, (Date.now() - previewT0) / 1000);
    const pulse = 1 + 0.35 * Math.sin(previewTick / 2.4);
    return {
      uploadTotal: Math.round(elapsed * 185_000 * pulse),
      downloadTotal: Math.round(elapsed * 2_450_000 * pulse),
      connections: [
        {
          id: 'preview-1',
          upload: Math.round(elapsed * 90_000 * pulse),
          download: Math.round(elapsed * 1_900_000 * pulse),
          start: new Date(Date.now() - 42_000).toISOString(),
          chains: ['🚀 节点选择', '🇯🇵 东京 01'],
          rule: 'DOMAIN-SUFFIX',
          rulePayload: 'youtube.com',
          metadata: { network: 'tcp', host: 'www.youtube.com', destinationPort: 443 },
        },
        {
          id: 'preview-2',
          upload: Math.round(elapsed * 35_000 * pulse),
          download: Math.round(elapsed * 430_000 * pulse),
          start: new Date(Date.now() - 12_000).toISOString(),
          chains: ['🚀 节点选择', '🇭🇰 香港 01'],
          rule: 'DOMAIN-SUFFIX',
          rulePayload: 'github.com',
          metadata: { network: 'tcp', host: 'github.com', destinationPort: 443 },
        },
        {
          id: 'preview-3',
          upload: Math.round(elapsed * 4_000 * pulse),
          download: Math.round(elapsed * 22_000 * pulse),
          start: new Date(Date.now() - 5_000).toISOString(),
          chains: ['DIRECT'],
          rule: 'GEOIP',
          rulePayload: 'CN',
          metadata: { network: 'udp', host: '223.5.5.5', destinationPort: 53 },
        },
      ],
    };
  }
  if (path.startsWith('/connections')) {
    previewTick += 1;
    const elapsed = Math.max(1, (Date.now() - previewT0) / 1000);
    // 造一条有起伏的曲线，截图时能看出视觉层次
    const wave = 0.65 + 0.35 * Math.sin(previewTick / 2.2);
    return {
      uploadTotal: Math.round(elapsed * 180_000 + wave * 60_000),
      downloadTotal: Math.round(elapsed * 2_400_000 + wave * 900_000),
      connections: [],
    };
  }
  if (path.startsWith('/proxies') && method === 'GET' && path.includes('/delay')) {
    return { delay: 36 + Math.round(Math.random() * 40) };
  }
  if (path.startsWith('/proxies')) {
    return JSON.parse(previewProxiesJson());
  }
  return {};
}

let previewKernelVersions: KernelVersionInfo[] = [
  {
    name: '内置内核',
    version: 'v1.19.32',
    path: '/Users/preview/Library/Application Support/PPClash/bin/mihomo',
    builtin: true,
    size: 61_386_224,
  },
  {
    name: 'v1.19.31',
    version: '1.19.31',
    path: '/Users/preview/Library/Application Support/PPClash/kernels/v1.19.31/mihomo',
    builtin: false,
    size: 61_000_000,
  },
];

function previewCall(cmd: string, args?: Record<string, unknown>): unknown {
  switch (cmd) {
    case 'mihomo_request': {
      const r = previewMihomo(
        String(args?.method ?? 'GET'),
        String(args?.path ?? '/')
      );
      return JSON.stringify(r);
    }
    case 'kernel_status':
      return { running: true, pid: 12345 };
    case 'start_kernel':
      return { running: true, pid: 12345 };
    case 'stop_kernel':
      return { running: false, pid: null };
    case 'get_system_proxy':
      return { enabled: true, host: '127.0.0.1', port: 7890 };
    case 'leak_check_ip':
      return { direct: '198.51.100.7', proxied: '203.0.113.42' };
    case 'leak_check_dns':
      return {
        kernel_alive: true,
        kernel_fake_ip: true,
        system_ips: ['198.18.0.23'],
        system_fake_ip: true,
      };
    case 'set_system_proxy':
      return { enabled: Boolean(args?.enable), host: '127.0.0.1', port: 7890 };
    case 'save_config':
      return '/Users/preview/Library/Application Support/PPClash/config.yaml';
    case 'load_app_state':
      return null;
    case 'list_kernel_versions':
      return previewKernelVersions;
    case 'list_kernel_releases': {
      const page = Number(args?.page ?? 1);
      const start = page === 1 ? 34 : page === 2 ? 14 : 10;
      return page <= 3 ? Array.from({ length: Math.min(20, start + 1) }, (_, index) => ({ version: `v1.${page < 3 ? 19 : 18}.${start - index}`, publishedAt: '2026-11-01T00:00:00Z' })) : [];
    }
    case 'download_kernel_version': {
      const tag = args?.version === 'Prerelease-Alpha' ? 'alpha-abcdef0-0123456789abcdef' : String(args?.version ?? 'v1.19.34');
      const existing = previewKernelVersions.find(version => version.version.replace(/^v/, '') === tag.replace(/^v/, ''));
      if (existing) return existing;
      const downloaded = { name: tag, version: tag, path: `/preview/kernels/${tag}/mihomo`, builtin: false, size: 61000000 };
      previewKernelVersions = [...previewKernelVersions, downloaded].sort((a, b) => Number(b.builtin) - Number(a.builtin) || b.version.localeCompare(a.version, undefined, { numeric: true }));
      return downloaded;
    }
    case 'remove_kernel_version':
      previewKernelVersions = previewKernelVersions.filter(version => version.builtin || version.path !== args?.path);
      return null;
    case 'list_resource_files':
      return [
        { name: 'geosite.dat', size: 4_272_747, exists: true },
        { name: 'geoip.metadb', size: 8_423_041, exists: true },
        { name: 'geoip.dat', size: 16_587_403, exists: true },
        { name: 'country.mmdb', size: 401_173, exists: true },
        { name: 'ASN.mmdb', size: 8_974_108, exists: true },
      ];
    case 'system_helper_info':
      return {
        installed: true,
        version: 'v1.19.32',
        needsUpdate: false,
        path: '/Library/PrivilegedHelperTools/ppclash/mihomo',
      };
    case 'kernel_info':
      return {
        running: true,
        version: 'v1.19.32',
        pid: 4321,
        rssKb: 96_000,
        binary: '/Users/preview/Library/Application Support/PPClash/bin/mihomo',
        bundledVersion: 'v1.19.32',
      };
    case 'tray_snapshot': {
      const nodes: TrayNode[] = [
        { name: '🇯🇵 东京 01', delay: 42, selected: true },
        { name: '🇭🇰 香港 01', delay: 36, selected: false },
        { name: '🇸🇬 新加坡 01', delay: 96, selected: false },
        { name: '🇺🇸 洛杉矶 01', delay: 168, selected: false },
        { name: '🇨🇳 台北 01', delay: 52, selected: false },
        { name: '🇰🇷 首尔 01', delay: 74, selected: false },
        { name: '🇬🇧 伦敦 01', delay: 196, selected: false },
      ];
      nodes.push(...Array.from({ length: (largePreview ? 1000 : 42) - nodes.length }, (_, i) => ({
        name: `🇯🇵 专线 ${String(i + 1).padStart(3, '0')}`, delay: 50 + i * 3, selected: false,
      })));
      const groups: TrayGroup[] = [
        { name: '自动选择', type: 'URLTest', now: '🇯🇵 东京 01', manual: false, total: nodes.length, nodes },
        { name: 'Example Air', type: 'Selector', now: '自动选择', manual: true, total: 3, nodes: [
          { name: '自动选择', delay: null, selected: true },
          { name: '🇺🇸 洛杉矶 01', delay: 168, selected: false },
          { name: 'DIRECT', delay: null, selected: false },
        ] },
        { name: '开发', type: 'Selector', now: '🇯🇵 东京 01', manual: true, total: nodes.length,
          nodes: nodes.map(node => ({ ...node, delay: null })) },
        { name: '分流均衡', type: 'LoadBalance', now: null, manual: false, total: nodes.length,
          nodes: nodes.map(node => ({ ...node, selected: false })) },
      ];
      return {
        running: true, sysProxy: false, tun: true, mode: 'rule',
        node: '🇯🇵 东京 01', group: 'Example Air', up: 185_000, down: 2_450_000, showSpeed: true,
        controllerPort: 9090, controllerSecret: 'preview', nodes, groups, groupsError: null,
        profiles: [
          { id: 'preview-profile', name: 'Example Air', updatedAt: Date.now() - 42 * 60_000,
            userinfo: { upload: 8 * 1024 ** 3, download: 36 * 1024 ** 3, total: 200 * 1024 ** 3, expire: 1805204537 } },
          { id: 'preview-backup', name: 'Demo Backup', updatedAt: Date.now() - 86_400_000,
            userinfo: { upload: 2 * 1024 ** 3, download: 58 * 1024 ** 3, total: 100 * 1024 ** 3, expire: 1802526137 } },
        ],
        activeProfile: 'preview-profile',
      };
    }
    case 'traffic_rates': {
      const t = (Date.now() - previewT0) / 1000;
      return [185_000 * (0.7 + 0.3 * Math.sin(t / 2.4)), 2_450_000 * (0.7 + 0.3 * Math.sin(t / 3.1 + 1))];
    }
    case 'check_ip_quality_auto':
      return {
        ip: '203.0.113.42',
        country: '日本',
        region: '东京都',
        city: '东京',
        isp: 'Example Hosting K.K.',
        org: 'Example Hosting K.K.',
        asn: 'AS64500 Example Hosting',
        hosting: true,
        proxy: false,
        mobile: false,
        kind: '机房 IP',
        risk: '中',
        score: 72,
      };
    case 'probe_service_auto':
      return {
        id: String(args?.id ?? 'google'),
        ok: true,
        latency_ms: 180 + Math.round(Math.random() * 260),
      };
    case 'read_kernel_log':
      return [
        'time="2026-11-02T20:00:01+08:00" level=info msg="Start initial configuration in progress"',
        'time="2026-11-02T20:00:01+08:00" level=info msg="Initial configuration complete, total time: 218ms"',
        'time="2026-11-02T20:00:02+08:00" level=info msg="[TCP] 127.0.0.1:52104 --> www.youtube.com:443 match DomainSuffix(youtube.com) using 🚀 节点选择[🇯🇵 东京 01 · IPLC]"',
        'time="2026-11-02T20:00:03+08:00" level=warning msg="[DNS] fallback is empty, using nameserver only"',
        'time="2026-11-02T20:00:05+08:00" level=info msg="[TCP] 127.0.0.1:52110 --> github.com:443 match DomainSuffix(github.com) using 🚀 节点选择[🇭🇰 香港 01 · 中转]"',
      ].join('\n');
    default:
      return null;
  }
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) {
    if (previewMode) return previewCall(cmd, args) as T;
    throw new Error(`浏览器预览模式不支持 ${cmd}，请用 npm run app 启动桌面端`);
  }
  return invoke<T>(cmd, args);
}

export const api = {
  androidAppInfo: () => call<{ version: string; build: number; abi: string; kernelVersion: string; debug: boolean }>('android_app_info'),
  androidSystemTheme: (light: boolean) => call<void>('android_system_theme', { light }),
  fetchSubscription: (url: string, proxyPort?: number) =>
    call<SubscriptionPayload>('fetch_subscription', { url, proxyPort }),

  /** 读取本地 Clash/mihomo 配置文件（10MB 上限，仅 yaml/yml/json）。 */
  readSubscriptionFile: (path: string) => call<string>('read_subscription_file', { path }),

  /** 导出过滤后的日志到用户选择的路径。 */
  exportLogFile: (path: string, content: string) =>
    call<void>('export_log_file', { path, content }),

  /** 检查应用更新；feed 返回 null 表示已是最新。 */
  checkAppUpdate: (feedUrl: string, currentVersion: string) =>
    call<AppUpdateInfo | null>('check_app_update', { feedUrl, currentVersion }),

  /** 内置 GitHub Releases 更新检查。 */
  checkGithubUpdate: (repo: string, currentVersion: string) =>
    call<AppUpdateInfo | null>('check_github_update', { repo, currentVersion }),

  /** 用系统浏览器打开 http(s) 链接。 */
  openExternalUrl: (url: string) => call<void>('open_external_url', { url }),

  /** 当前进程是否以管理员权限运行。 */
  isElevated: () => call<boolean>('is_elevated'),

  /** Windows: 以管理员身份重启应用；其它平台直接重启。 */
  restartAsAdmin: () => call<void>('restart_as_admin'),

  /** 读取托盘/菜单栏同一份实时速率缓存。 */
  trafficRates: () => call<[number, number]>('traffic_rates'),

  /** 追加一条前端诊断日志。 */
  appendDiagnosticLog: (level: string, message: string) =>
    call<void>('append_diagnostic_log', { level, message }),

  /** 导出脱敏诊断包，返回 zip 路径。 */
  exportDiagnostics: () => call<string>('export_diagnostics'),

  /** 查询出口 IP 的类型 / 风险 / ASN / 地区。 */
  checkIpQuality: (ip: string) =>
    call<{
      ip: string;
      country: string | null;
      region: string | null;
      city: string | null;
      isp: string | null;
      org: string | null;
      asn: string | null;
      hosting: boolean;
      proxy: boolean;
      mobile: boolean;
      kind: string;
      risk: string;
      score: number;
    }>('check_ip_quality_auto', { ip }),

  /** 查询出口 IP 的国家/地区。 */
  lookupIpCountry: (ip: string) =>
    call<{ country: string | null; country_code: string | null }>('lookup_ip_country_auto', {
      ip,
    }),

  /** 并发探测单个服务：前端可以逐项渲染。 */
  probeNodeHealth: (node: string) => call<Record<string, boolean | null>>('probe_node_health', { node }),

  probeService: (id: string, egressNode?: string | null) =>
    call<ServiceProbe>('probe_service_auto', {
      id,
      egressNode: egressNode ?? null,
    }),

  /** 通过 mihomo mixed 端口探测常用服务连通性。 */
  probeServices: () =>
    call<Array<{ id: string; ok: boolean; latency_ms: number | null }>>(
      'probe_services_auto'
    ),

  /** 下载更新包到临时目录（可选 sha256 校验）。 */
  downloadAppUpdate: (url: string, sha256: string | null) =>
    call<string>('download_app_update', { url, sha256 }),

  /** 打开下载好的更新包。 */
  openDownloadedUpdate: (path: string) =>
    call<void>('open_downloaded_update', { path }),

  /** TUN 提权内核状态。 */
  systemHelperInfo: () => call<HelperInfo>('system_helper_info'),

  /** 安装/更新 TUN 提权内核（会弹一次管理员授权）。 */
  installSystemHelper: () => call<HelperInfo>('install_system_helper'),

  /** 卸载系统提权内核。 */
  uninstallSystemHelper: () => call<HelperInfo>('uninstall_system_helper'),

  saveConfig: (content: string, dataDir: string) =>
    call<string>('save_config', { content, dataDir }),

  prepareConfig: (content: string, dataDir: string) =>
    call<string>('prepare_config', { content, dataDir }),

  commitConfig: (candidatePath: string) =>
    call<string>('commit_config', { candidatePath }),

  finishConfig: (candidatePath: string, rollback: boolean) =>
    call<void>('finish_config', { candidatePath, rollback }),

  discardConfig: (candidatePath: string) =>
    call<void>('discard_config', { candidatePath }),

  startKernel: (
    configPath: string,
    dataDir: string,
    binaryPath: string | null,
    privileged: boolean,
    controllerPort: number,
    controllerSecret: string
  ) =>
    call<KernelStatus>('start_kernel', {
      configPath,
      dataDir,
      binaryPath: binaryPath ?? null,
      privileged,
      controllerPort,
      controllerSecret,
    }),

  stopKernel: () => call<KernelStatus>('stop_kernel'),

  /** 清理上次崩溃/强退留下的内核进程（含 TUN）。 */
  cleanupStaleKernel: () => call<void>('cleanup_stale_kernel'),

  kernelStatus: (controllerSecret = '') =>
    call<KernelStatus>('kernel_status', { secret: controllerSecret, port: Number(new URL(mihomoBase).port) }),

  /** 重新解压内置内核与 Geo 数据。 */
  reinstallResources: () => call<string>('reinstall_bundled_resources'),

  /** 本地可用内核版本：内置 + 已下载。 */
  listKernelVersions: () => call<KernelVersionInfo[]>('list_kernel_versions'),

  /** 内置 Geo 资源文件状态。 */
  listResourceFiles: () =>
    call<Array<{ name: string; size: number; exists: boolean }>>('list_resource_files'),

  /** 按需读取适用于当前平台、可校验的官方稳定版本。 */
  listKernelReleases: (proxyUrl?: string, page = 1) =>
    call<KernelReleaseInfo[]>('list_kernel_releases', { proxyUrl, page }),

  /** 下载指定官方稳定版本；留空为最新版本，不改变选用设置。 */
  downloadKernelVersion: (proxyUrl?: string, mirrorPrefix?: string, version?: string) =>
    call<KernelVersionInfo>('download_kernel_version', { proxyUrl, mirrorPrefix, version }),

  removeKernelVersion: (path: string) => call<void>('remove_kernel_version', { path }),

  /** 从内置 MetaCubeX 在线源更新单个 Geo 文件。 */
  downloadGeoResource: (name: string, url: string, proxyUrl?: string, mirrorPrefix?: string) =>
    call<number>('download_geo_resource', { name, url, proxyUrl, mirrorPrefix }),

  /** 内核版本 / 内存 / 路径。 */
  kernelInfo: () => call<KernelInfo>('kernel_info'),

  /** 用内核 -t 校验生成配置。 */
  validateConfig: (configPath: string, dataDir: string) =>
    call<void>('validate_config', { configPath, dataDir }),

  /** 从 .app 包提取进程图标，返回 data URL。 */
  resolveProcessIcon: (processPath: string) =>
    call<string | null>('resolve_process_icon', { processPath }),

  /** 读取内核日志尾部若干行。 */
  readKernelLog: (lines = 400) => call<string>('read_kernel_log', { lines }),

  /** 备份当前 state.json 到数据目录 backups/。 */
  backupAppState: (dataDir: string) => call<string>('backup_app_state', { dataDir }),
  webdavList: (connection: WebDavConnection) => call<string[]>('webdav_list', { connection }),
  webdavUpload: (connection: WebDavConnection, passphrase: string, device: string) =>
    call<string>('webdav_upload', { connection, passphrase, device }),
  webdavPreview: (connection: WebDavConnection, name: string, passphrase: string) =>
    call<WebDavBackupPreview>('webdav_preview', { connection, name, passphrase }),
  webdavRestore: (backup: WebDavRestore, session: string) => call<void>('webdav_restore', { ...backup, session }),

  /** 已有备份列表（新的在前）。 */
  listBackups: (dataDir: string) =>
    call<Array<{ name: string; size: number; mtimeMs: number }>>('list_backups', { dataDir }),

  /** 从备份恢复 state.json（需要重新加载应用）。 */
  restoreBackup: (dataDir: string, name: string) =>
    call<void>('restore_backup', { dataDir, name }),

  setSystemProxy: (enable: boolean, host: string, port: number) =>
    call<SysProxyState>('set_system_proxy', { enable, host, port }),

  getSystemProxy: () => call<SysProxyState>('get_system_proxy'),

  /** 开机自启（macOS LaunchAgent）。 */
  setLaunchLogin: (enable: boolean) => call<void>('set_launch_login', { enable }),

  /** 关窗行为：true=最小化到托盘，false=直接退出。 */
  setCloseToTray: (enabled: boolean) => call<void>('set_close_to_tray', { enabled }),

  /** 在 Finder 打开数据目录。 */
  openDataDir: (dataDir: string) => call<void>('open_data_dir', { dataDir }),

  /** 落盘应用状态（订阅 / 活动订阅 / 策略 / 设置）。 */
  saveAppState: (content: string, dataDir: string, session?: string) =>
    call<void>('save_app_state', { content, dataDir, session }),

  /** 读取应用状态。没有则返回 null。 */
  loadAppState: (dataDir: string, session?: string) => call<string | null>('load_app_state', { dataDir, session }),

  /** 转发一次 mihomo API 请求。base / secret 可配，默认走本机控制端口。 */
  mihomo: async (
    method: string,
    path: string,
    body?: unknown,
    base?: string,
    secret?: string
  ): Promise<unknown> => {
    const raw = await call<string>('mihomo_request', {
      base: base ?? mihomoBase,
      secret: secret ?? mihomoSecret,
      method,
      path,
      body: body === undefined ? null : JSON.stringify(body),
    });
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  },

  /** 把前端状态（TUN / 系统代理 / 端口）推给托盘并重建托盘菜单。 */
  setTrayFlags: (
    tunEnabled: boolean,
    sysProxyEnabled: boolean,
    mixedPort: number,
    mode: string,
    showSpeed: boolean,
    hideDock: boolean,
    controllerSecret: string,
    primaryGroup: string,
    groupOrder: string[] = []
  ) =>
    call<void>('set_tray_flags', {
      tunEnabled,
      sysProxyEnabled,
      mixedPort,
      mode,
      showSpeed,
      hideDock,
      controllerSecret,
      primaryGroup,
      groupOrder,
    }),

  traySnapshot: () => call<TraySnapshot>('tray_snapshot'),

  trayAction: (action: string, value?: TrayActionValue) =>
    call<void>('tray_action', { action, value: value ?? null }),

  /** 泄漏自检：直连 vs 代理出口 IP。 */
  leakCheckIp: (mixedPort: number, tunEnabled = false) =>
    call<{ direct: string | null; proxied: string | null }>('leak_check_ip', {
      mixedPort,
      tunEnabled,
    }),

  /** 泄漏自检：DNS 接管状态（内核 DNS 端口 + 系统解析）。 */
  leakCheckDns: (domain: string, dnsPort = 1053) =>
    call<{
      kernel_alive: boolean;
      kernel_fake_ip: boolean;
      system_ips: string[];
      system_fake_ip: boolean;
    }>('leak_check_dns', { domain, dnsPort }),
};

/** 数据目录，跟内核工作目录一致。 */
export const DATA_DIR = 'PPClash';
