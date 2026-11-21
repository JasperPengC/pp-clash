import type { RuleEditState } from './rules';
import type { TrafficInfo } from '../core/subscription';
import type { TargetLatencies } from '../core/latency';
import type { TextSize, ThemeMode } from './appearance';
export type { TextSize, ThemeMode } from './appearance';

export interface CollectionRecipe { sources: string[]; include: string; exclude: string; find: string; replace: string }

export interface Profile {
  id: string;
  /** 优先用订阅响应头里的名字；没有则回落到 URL 主机名。 */
  name: string;
  url: string;
  raw: string;
  updatedAt: number;
  /** subscription-userinfo：已用 / 总量 / 到期时间。旧版本保存的订阅没有这个字段。 */
  userinfo: TrafficInfo | null;
  /** profile-update-interval（小时）。 */
  updateIntervalHours: number | null;
  /** 自动更新间隔：null = 跟随订阅；0 = 关闭；其它为小时。 */
  autoUpdateHours?: number | null;
  /** 更新订阅时走本机代理（需要内核运行）。 */
  useProxy?: boolean;
  /** 来源：远程订阅链接或本地文件；旧数据没有该字段时按 url 处理。 */
  sourceType?: 'url' | 'file' | 'collection';
  collection?: CollectionRecipe;
  /** 订阅规则的启停/目标/排序覆盖。 */
  ruleEdits?: RuleEditState;
}

export interface CustomRule {
  id: string;
  type: string;
  payload: string;
  target: string;
  enabled: boolean;
}

export interface ProxyNode {
  name: string;
  type: string;
  delay: number | null;
  delaysByTarget?: TargetLatencies;
}

export interface ProxyRuntimeSnapshot {
  profileId: string | null;
  revision: number;
  connectedAt: number | null;
  proxies: Record<string, unknown>;
  providers?: unknown;
  providersError?: string;
  providersChecked?: boolean;
  sessionEpoch?: number;
}

export interface ProxyGroup {
  name: string;
  type: string;
  now: string;
  nodes: ProxyNode[];
}


export type ToastKind = 'error' | 'success' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

/** 用户真正会改、且需要跨启动保留的偏好。 */
export interface AppSettings {
  theme: ThemeMode;
  textSize: TextSize;
  /** 混合端口：系统/应用代理指向这里。 */
  mixedPort: number;
  /** mihomo 控制端口：前端经它读流量/延迟/切换节点。 */
  controllerPort: number;
  /** mihomo 控制端口 bearer secret。 */
  controllerSecret: string;
  /** 自定义内核路径；留空则按优先级自动查找。 */
  kernelPath: string;
  /** 开机自启（macOS LaunchAgent）。 */
  launchAtLogin: boolean;
  /** 关窗最小化到托盘而不是退出。 */
  closeToTray: boolean;
  /** 出站模式：规则 / 全局 / 直连。 */
  mode: OutboundMode;
  /** 额外监听端口；0 表示关闭。 */
  socksPort: number;
  httpPort: number;
  redirPort: number;
  bindAddress: string;
  authUser: string;
  authPass: string;
  /** 允许局域网设备连接本机代理。 */
  allowLan: boolean;
  /** 进阶模式：显示规则、日志、覆写、内核等高级页面。 */
  advancedMode: boolean;
  traySpeed: boolean;
  /** 关闭窗口后隐藏 Dock 图标（菜单栏常驻）。 */
  hideDockOnClose: boolean;
  /** 设置结构版本，用于一次性迁移。 */
  settingsVersion: number;
  /** 内核 DNS 监听端口。 */
  dnsPort: number;
  /** DNS 服务器：自动（安全策略）/ 预设 DoH / 自定义。 */
  dnsNameserver: DnsNameserverMode;
  /** Geo 数据模式：db 使用 metadb，dat 使用旧 dat 文件。 */
  geoDataMode: 'db' | 'dat';
  /** 内核按 interval 自动更新 Geo 数据。 */
  geoAutoUpdate: boolean;
  geoUpdateInterval: number;
  /** 内置在线 Geo 源；资源页可直接编辑。 */
  geoUrls: {
    geoip: string;
    geosite: string;
    mmdb: string;
    asn: string;
    country: string;
  };
  dnsCustom: string;
  /** 嗅探：从握手提取域名。 */
  snifferEnabled: boolean;
  snifferOverrideDestination: boolean;
  /** 订阅自动更新（按机场返回的 profile-update-interval，缺省 24h）。 */
  autoUpdate: boolean;
  /** 节点不可用时自动探测并切换到同组可用节点。 */
  autoFailover: boolean;
  stableRouting: boolean;
  /** 进阶覆写：多份 YAML/JS 文件，按顺序合并到生成配置。 */
  overrides: OverrideFile[];
  /** GitHub 下载代理前缀（下载内核/资源时使用，留空直连）。 */
  githubProxy: string;
  /** 自定义规则（插在防护规则之后、订阅规则之前）。 */
  customRules: CustomRule[];
  /** 应用更新 feed；留空关闭检查。 */
  updateFeedUrl: string;
  /** 启动时自动检查应用更新。 */
  updateCheckOnLaunch: boolean;
}

export type OutboundMode = 'rule' | 'global' | 'direct';
export type DnsNameserverMode = 'auto' | 'cloudflare' | 'google' | 'quad9' | 'custom';

export interface OverrideFile {
  id: string;
  name: string;
  mode: 'yaml' | 'js';
  enabled: boolean;
  text: string;
}

export type KernelPhase = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
