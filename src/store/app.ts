import { buildCollection, collectionSources } from '../application/profile-collection';
import type { CollectionRecipe, SubStoreReference } from '../domain/app';
import { downloadSubStoreProfile } from '../core/sub-store/download';
import { webdavService } from '../core/webdav-service';
import { isGroupNode, parseRuntimeGroups } from '../core/proxy-runtime';
import { createStatePersistence } from '../application/persistence';
import { createTrayPublisher } from '../application/tray-sync';
import { restoreProxySelections } from '../application/restore-proxy-selections';
import { runtimeOf, overrideOf, configurationInputs, prepareConfigCandidate, type ConfigInputs } from '../application/configuration';
import type { Profile, CustomRule, ProxyRuntimeSnapshot, ProxyGroup, ToastKind, Toast, AppSettings, OutboundMode, KernelPhase } from '../domain/app';
import { DEFAULT_SETTINGS } from '../domain/settings';
export type { Profile, CustomRule, ProxyNode, ProxyRuntimeSnapshot, ProxyGroup, ThemeMode, ToastKind, Toast, AppSettings, OutboundMode, DnsNameserverMode, OverrideFile, KernelPhase } from '../domain/app';
export { DEFAULT_SETTINGS } from '../domain/settings';
import { create } from 'zustand';
import { createSettingsApplication, type SettingsApplicationOptions, type SettingsApplicationResult } from '../application/apply-runtime-settings';
import { Lifecycle } from '../core/lifecycle';
import { api, DATA_DIR, isTauri, setMihomoBase, setMihomoSecret } from '../core/api';
import { generateConfig, type ConfigStats, type RuleEditState } from '../core/generator';
import type { AppUpdateInfo, WebDavRestore } from '../core/api';
import type { Finding } from '../core/audit';
import { DEFAULT_POLICY, type SecurityPolicy } from '../core/security';
import { countRealNodes, parseSubscriptionMeta, validateSubscriptionCandidate } from '../core/subscription';
import { useTheme } from './theme';
import { currentTextSize, normalizeTextSize, restoreTextSize, setTextSize, textSizeRevision } from './text-size';
import { isAndroid, isWindows } from '../core/platform';
import { logEvent } from '../core/logger';
import { APP_VERSION, UPDATE_REPO } from '../core/update';
import { routingPolicy, subscriptionRoutingPolicy, type RoutingPolicy } from '../core/routing-policy';
import { DEFAULT_LATENCY_URL, GITHUB_LATENCY_URL, groupLatencyTarget, latencyTestQuery, normalizeLatency, parseTargetLatencies, type TargetLatencies } from '../core/latency';
import type { DelayTestOptions, LatencyResult } from '../core/latency-batch';
import { readProxyConfiguration } from '../core/proxy-domain';
import { normalizeSubscriptionUrl, sameSubscriptionUrl, subscriptionFileName } from '../core/subscription-source';

export interface SavedWebDavRestore { savedWebDav: true; name: string; passphrase: string; digest: string }

interface AppStore {
  profiles: Profile[];
  activeId: string | null;
  updateInfo: AppUpdateInfo | null;
  checkingUpdate: boolean;
  downloadingUpdate: boolean;
  updateError: string | null;
  updateCheckedAt: number | null;
  /** Windows 是否以管理员权限运行。 */
  elevated: boolean;
  /** 是否显示「TUN 需要管理员」确认框。 */
  elevationPrompt: boolean;
  elevationBusy: boolean;
  policy: SecurityPolicy;
  policyApplying: boolean;
  policyError: string | null;
  settings: AppSettings;
  tunEnabled: boolean;
  sysProxyEnabled: boolean;
  /** 本会话确认或已经请求过的代理端口，不能随待应用设置丢失。 */
  ownedProxyPorts: number[];
  kernelPhase: KernelPhase;
  /** 本次连接开始时间（ms），用于概览显示运行时长。 */
  connectedAt: number | null;
  /** 最近一次内核启动/运行失败的原因，直接展示给用户。 */
  kernelError: string | null;
  groups: ProxyGroup[];
  proxyRuntime: ProxyRuntimeSnapshot | null;
  routing: RoutingPolicy | null;
  routeRevision: number;
  /** 已尝试生效的运行配置代次；节点选择不会改变它。 */
  runtimeConfigRevision: number;
  runtimeConfigTransition: boolean;
  /** 恢复/水合期间阻止所有旧内存切片持久化。 */
  persistenceFrozen: boolean;
  /** 磁盘已恢复而内存尚未接受恢复态；普通读取取消不能解除此屏障。 */
  restoredStatePending: boolean;
  restoringBackup: boolean;
  persistenceSession?: string;
  /** 旧版收藏/置顶排序数据，不代表固定使用。 */
  pinnedNodes: Record<string, string[]>;
  /** 明确确认过的固定选择：订阅 ID -> 分组 -> 节点；旧置顶不迁移为出口命令。 */
  fixedNodes: Record<string, Record<string, string>>;
  /** 已由控制器确认的选择，按订阅隔离；与固定策略独立。 */
  selectedNodes: Record<string, Record<string, string>>;
  audit: Finding[];
  stats: ConfigStats | null;
  toast: Toast | null;
  busy: boolean;
  /** 正在导入订阅。 */
  importing: boolean;
  importStage: 'fetching' | 'validating' | 'applying' | null;
  activatingProfile: boolean;
  /** 正在更新哪些订阅。 */
  refreshingIds: string[];
  /** 仅当前会话显示的订阅更新失败原因，不写入持久化状态。 */
  profileRefreshErrors: Record<string, string>;

  /** 非持久化的派生路径：save_config 返回的绝对 config.yaml 与其所在目录。 */
  configPath: string;
  dataDir: string;

  /** 启动时从磁盘水合。 */
  hydrate: () => Promise<void>;
  restoreBackup: (backup: string | WebDavRestore | SavedWebDavRestore) => Promise<void>;
  importProfile: (url: string, useProxy?: boolean) => Promise<boolean>;
  /** 导入本地 YAML/JSON 文件；url 字段保存文件路径，便于后续重新读取。 */
  saveCollection: (name: string, recipe: CollectionRecipe, id?: string) => Promise<void>;
  addSubStoreProfile: (name: string, reference: SubStoreReference, raw: string) => Promise<void>;
  renameSubStoreReferences: (change: { kind: SubStoreReference['kind']; oldName: string; newName: string }) => Promise<void>;
  importProfileFile: (path: string) => Promise<boolean>;
  activate: (id: string) => Promise<void>;
  removeProfile: (id: string) => Promise<void>;
  refreshProfile: (id: string, quiet?: boolean) => Promise<boolean>;
  /** 更新单个订阅的本地设置（自动更新间隔 / 是否走代理）。 */
  updateProfile: (id: string, patch: Partial<Profile>) => void;
  /** 更新当前活动订阅的规则编辑并立即应用。 */
  updateRuleEdits: (edits: RuleEditState) => Promise<void>;
  /** 调整订阅顺序（-1 上移，1 下移）。 */
  moveProfile: (id: string, dir: -1 | 1) => void;
  /** 拖拽排序：把 fromId 移到 toId 的位置。 */
  reorderProfiles: (fromId: string, toId: string) => void;
  applyConfig: () => Promise<boolean>;
  startKernel: (quiet?: boolean) => Promise<void>;
  stopKernel: (quiet?: boolean) => Promise<void>;
  /** 串行重启内核：避免多个配置修改同时 stop/start 互相踩踏。 */
  restartKernel: (quiet?: boolean, expectedToken?: number, prepared?: boolean) => Promise<boolean>;
  /** 彻底断开：停内核并清掉系统代理 / TUN 两个接管开关。 */
  disconnect: () => Promise<void>;
  /** 内核意外退出时由心跳探测调用：纠正 UI 状态并兜底关闭系统代理。 */
  handleKernelLost: () => Promise<void>;
  refreshGroups: (quiet?: boolean) => Promise<boolean>;
  /** 来源元数据按会话读取一次；显式刷新可重试，不能阻塞节点确认。 */
  refreshProxyProviders: (force?: boolean) => Promise<boolean>;
  selectNode: (group: string, node: string, expectedRevision?: string, beforeSelect?: () => boolean) => Promise<boolean>;
  togglePinNode: (group: string, node: string) => void;
  toggleFixedNode: (group: string, node: string) => Promise<boolean>;
  testDelay: (node: string, targetUrl?: string, options?: DelayTestOptions) => Promise<number | null>;
  publishDelayBatch: (results: LatencyResult[]) => void;
  toggleSystemProxy: (on: boolean) => Promise<void>;
  /** 托盘事件回写（只改状态并持久化，不再发系统调用）。 */
  setSysProxyEnabled: (on: boolean) => void;
  setTun: (on: boolean) => Promise<void>;
  syncAndroidVpn: (active: () => boolean) => Promise<boolean>;
  setPolicy: (patch: Partial<SecurityPolicy>) => Promise<boolean>;
  updateSettings: (patch: Partial<AppSettings>) => void;
  applyRuntimeSettings: (patch: Partial<AppSettings>, options?: SettingsApplicationOptions) => Promise<SettingsApplicationResult>;
  changeOutboundMode: (mode: OutboundMode) => Promise<void>;
  notify: (kind: ToastKind, text: string) => void;
  clearToast: () => void;
  checkUpdate: (silent?: boolean) => Promise<void>;
  downloadUpdate: () => Promise<void>;
  dismissUpdate: () => void;
  confirmElevation: () => Promise<void>;
  cancelElevation: () => void;
}

function nameFromPath(path: string): string {
  const base = subscriptionFileName(path);
  return base.replace(/\.(ya?ml|json)$/i, '') || '本地订阅';
}

function nameFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '未命名订阅';
  }
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : JSON.stringify(e);
}

/** 内核启动失败/校验失败时撤掉系统代理，避免全网断线。 */
async function disableProxyOnFailure(port: number) {
  if (!isTauri) return;
  try {
    await api.setSystemProxy(false, '127.0.0.1', port);
  } catch {
    /* 尽力而为 */
  }
}

const lifecycle = new Lifecycle();
const applyRuntimeSettings = createSettingsApplication({
  read: () => { const s = useApp.getState(); return { settings: s.settings, kernelPhase: s.kernelPhase, hasProfile: s.profiles.some(p => p.id === s.activeId) }; },
  token: () => lifecycle.token(), current: token => lifecycle.current(token),
  update: patch => useApp.getState().updateSettings(patch),
  invalidate: () => useApp.setState({ configPath: '' }),
  apply: () => useApp.getState().applyConfig(),
  restart: token => useApp.getState().restartKernel(true, token, true),
});
export const getLifecycleToken = () => lifecycle.token();
export const isLifecycleCurrent = (token: number) => lifecycle.current(token);
let configRequest = 0;
let configPending = 0;
let configCommitChain: Promise<unknown> = Promise.resolve();
const profileRefreshes = new Map<string, Promise<boolean>>();
let proxyReadEpoch = 0;
const proxyProviderReads = new Map<number, Promise<boolean>>();
const proxySessionIdentity = (state: AppStore) => JSON.stringify([state.activeId, state.runtimeConfigRevision,
  state.runtimeConfigTransition, state.connectedAt, state.kernelPhase, state.settings.controllerPort, state.settings.controllerSecret]);
const proxySnapshotMatches = (snapshot: ProxyRuntimeSnapshot | null, state: AppStore) => Boolean(snapshot
  && snapshot.profileId === state.activeId && snapshot.revision === state.runtimeConfigRevision && snapshot.connectedAt === state.connectedAt
  && (snapshot.sessionEpoch === undefined || snapshot.sessionEpoch === proxyReadEpoch));
let configRevision = 0;
let manualSelectionRequest = 0;
let persistenceRevision = 0;
let hydrationRequest = 0;
let preparedRouting: RoutingPolicy | null = null;
export const getRoutingRevision = (): string => String(useApp.getState().routeRevision);
let globalGroup: ProxyGroup | undefined;
export const getGlobalGroup = () => globalGroup;

export function primaryRoutingGroup(s: Pick<AppStore, 'groups' | 'profiles' | 'activeId' | 'settings'> & { routing?: RoutingPolicy | null }): ProxyGroup | undefined {
  if (s.settings.mode === 'global') return globalGroup;
  const raw = s.profiles.find(p => p.id === s.activeId)?.raw ?? '';
  const primary = (s.routing ?? subscriptionRoutingPolicy(raw)).primary;
  return s.groups.find(g => g.name === primary) ?? s.groups[0];
}
let validatedRevision = -1;
let validatedPath = '';
let preparedInputs: ConfigInputs | null = null;
let preparedInputKey = '';
let preparedDataDir = '';

function preparedFor(s: AppStore): boolean {
  return Boolean(preparedInputKey && s.configPath && s.configPath === validatedPath
    && s.dataDir === preparedDataDir && validatedRevision === configRevision
    && JSON.stringify(configInputsOf(s)) === preparedInputKey);
}

function rememberProxyPort(port: number) {
  const ports = useApp.getState().ownedProxyPorts;
  if (!ports.includes(port)) useApp.setState({ ownedProxyPorts: [...ports, port] });
}

async function enableSystemProxy(port: number) {
  // 记录已发出的写入，停止即使先于成功回调也能识别所属端点。
  rememberProxyPort(port);
  return api.setSystemProxy(true, '127.0.0.1', port);
}

function saveFixedNode(profileId: string, group: string, node?: string) {
  const s = useApp.getState();
  const records = { ...s.fixedNodes[profileId] };
  if (node) records[group] = node;
  else delete records[group];
  useApp.setState({ fixedNodes: { ...s.fixedNodes, [profileId]: records } });
  void persist(useApp.getState());
}

async function saveSelectedNode(profileId: string, group: string, node?: string) {
  const s = useApp.getState();
  const records = { ...s.selectedNodes[profileId] };
  if (node) records[group] = node;
  else delete records[group];
  useApp.setState({ selectedNodes: { ...s.selectedNodes, [profileId]: records } });
  await persist(useApp.getState());
}

function normalizeFixedNodes(value: unknown, profiles: Profile[]): Record<string, Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(profiles.map(profile => {
    const groups = (value as Record<string, unknown>)[profile.id];
    return [profile.id, groups && typeof groups === 'object' && !Array.isArray(groups)
      ? Object.fromEntries(Object.entries(groups).filter(([group, node]) => group && typeof node === 'string' && node)) : {}];
  }));
}

/** 调用方持有 lifecycle 串行队列；启动恢复直接复用，避免嵌套排队。 */
async function selectNodeFor(token: number, profileId: string | null, group: string, node: string,
  revision: string, kind: 'manual' | 'automatic' | 'fixed' | 'restore' | 'remember', context = restorationContextOf(useApp.getState())): Promise<boolean> {
  const restoring = kind === 'restore' || kind === 'remember';
  const current = () => lifecycle.current(token) && useApp.getState().activeId === profileId
    && (useApp.getState().kernelPhase === 'running' || (restoring && useApp.getState().kernelPhase === 'starting'))
    && (restoring ? Boolean(profileId && (kind === 'restore' ? useApp.getState().fixedNodes : useApp.getState().selectedNodes)[profileId]?.[group] === node
      && context === restorationContextOf(useApp.getState()))
      : getRoutingRevision() === revision);
  if (!current()) return false;
  const target = group === 'GLOBAL' ? globalGroup : useApp.getState().groups.find(g => g.name === group);
  const member = target?.nodes.find(n => n.name === node);
  // 面板快照和点击之间，组类型可能已改变；手选在执行边界再次校验。
  if ((kind === 'manual' || kind === 'remember') && target?.type !== 'Selector') return false;
  if (!member || ((kind === 'fixed' || kind === 'restore')
      && (target?.type !== 'Selector' || isGroupNode(member, useApp.getState().groups)))) return false;
  try {
    await api.mihomo('PUT', `/proxies/${encodeURIComponent(group)}`, { name: node });
    if (!current()) return false;
    const refreshed = restoring ? await refreshFixedGroupsFor(token, profileId, context)
      : await useApp.getState().refreshGroups();
    if (!current()) return false;
    const confirmed = group === 'GLOBAL' ? globalGroup : useApp.getState().groups.find(g => g.name === group);
    if (!refreshed || confirmed?.now !== node) throw new Error('控制器未确认选中该节点');
    if ((kind === 'fixed' || kind === 'restore')
        && confirmed.nodes.some(n => n.name === node && isGroupNode(n, useApp.getState().groups))) return false;
    if (profileId) {
      const fixed = useApp.getState().fixedNodes[profileId]?.[group];
      if (kind === 'fixed' || (kind === 'automatic' && fixed)) saveFixedNode(profileId, group, node);
      else if (kind === 'manual' && fixed && fixed !== node) saveFixedNode(profileId, group);
      if (!restoring && confirmed?.type === 'Selector') await saveSelectedNode(profileId, group, node);
    }
    await pushTray(useApp.getState());
    return current();
  } catch (e) {
    if (current()) useApp.getState().notify('error', `切换节点失败：${errorText(e)}`);
    return false;
  }
}

function restorationContextOf(s: AppStore): string {
  const inputs = configInputsOf(s);
  // 恢复会改变观测节点；取消其它分组固定也不改变本次连接的配置/控制器身份。
  return JSON.stringify(inputs && { ...inputs, runtime: { ...inputs.runtime, currentNode: '', fixedNodes: {}, selectedNodes: {} } });
}

function restorationCurrent(token: number, profileId: string | null, context: string): boolean {
  return lifecycle.current(token) && useApp.getState().activeId === profileId && restorationContextOf(useApp.getState()) === context;
}

async function refreshFixedGroupsFor(token: number, profileId: string | null, context: string): Promise<boolean> {
  const revision = getRoutingRevision();
  const refreshed = await useApp.getState().refreshGroups();
  if (!restorationCurrent(token, profileId, context)) return false;
  // 取消其它固定会使在途读结果过期；只重读一次，绝不据旧分组发出恢复。
  return refreshed || (revision !== getRoutingRevision() && await useApp.getState().refreshGroups()
    && restorationCurrent(token, profileId, context));
}

async function restoreFixedNodesFor(token: number, profileId: string | null, context: string): Promise<boolean> {
  if (!profileId) return true;
  const current = () => restorationCurrent(token, profileId, context);
  for (const [group, node] of Object.entries(useApp.getState().fixedNodes[profileId] ?? {})) {
    if (!current()) return false;
    if (useApp.getState().fixedNodes[profileId]?.[group] !== node) continue;
    const target = useApp.getState().groups.find(g => g.name === group);
    if (target?.type !== 'Selector' || !target.nodes.some(n => n.name === node && !isGroupNode(n, useApp.getState().groups))) {
      saveFixedNode(profileId, group);
      continue;
    }
    if (target.now === node) continue;
    const restored = await selectNodeFor(token, profileId, group, node, getRoutingRevision(), 'restore', context);
    if (!current()) return false;
    // 用户取消固定后，迟到的控制器应答不重新发布固定，也不继续恢复旧意图。
    if (useApp.getState().fixedNodes[profileId]?.[group] !== node) continue;
    if (!restored) return false;
  }
  return current();
}

/** 普通记忆按实际成员恢复；移除/改类型时回退，不能把过期偏好当成固定命令。 */
async function restoreSelectedNodesFor(token: number, profileId: string | null, context: string): Promise<void> {
  if (!profileId) return;
  for (const [group, node] of Object.entries(useApp.getState().selectedNodes[profileId] ?? {})) {
    if (!restorationCurrent(token, profileId, context)) return;
    if (useApp.getState().fixedNodes[profileId]?.[group]) continue;
    const target = group === 'GLOBAL' ? globalGroup : useApp.getState().groups.find(g => g.name === group);
    if (target?.type !== 'Selector' || !target.nodes.some(member => member.name === node)) {
      await saveSelectedNode(profileId, group);
      continue;
    }
    if (target.now !== node) await selectNodeFor(token, profileId, group, node, getRoutingRevision(), 'remember', context);
  }
}

/** 接管已运行的内核不拥有其启动；读失败保留现有会话，只阻止新增代理接管。 */
async function adoptRunningKernelFor(token: number, wantsTun: boolean, wantsSysProxy: boolean): Promise<void> {
  const profileId = useApp.getState().activeId;
  const context = restorationContextOf(useApp.getState());
  useApp.setState({ kernelPhase: 'starting', connectedAt: Date.now() });
  await lifecycle.serial(async () => {
    const current = () => lifecycle.current(token);
    if (!current()) return;
    const refreshed = await refreshFixedGroupsFor(token, profileId, context);
    if (!current()) return;
    const restored = restorationCurrent(token, profileId, context)
      && (!Object.keys(useApp.getState().fixedNodes[profileId ?? ''] ?? {}).length
        || (refreshed && await restoreFixedNodesFor(token, profileId, context)));
    if (refreshed && restored) await restoreSelectedNodesFor(token, profileId, context);
    if (!current()) return;
    const actual = await api.getSystemProxy().catch(() => null);
    if (!current()) return;
    const settings = useApp.getState().settings;
    if (actual) {
      if (actual.enabled && actual.port === settings.mixedPort) rememberProxyPort(actual.port);
      useApp.setState({ sysProxyEnabled: actual.enabled });
    }
    if (restored && restorationCurrent(token, profileId, context) && wantsSysProxy && actual && !actual.enabled) {
      try {
        const sp = await enableSystemProxy(settings.mixedPort);
        if (!current()) return;
        useApp.setState({ sysProxyEnabled: sp.enabled });
        void persist(useApp.getState());
      } catch (e) {
        if (current()) useApp.getState().notify('error', `恢复系统代理失败：${errorText(e)}`);
      }
    }
    if (!current()) return;
    if (wantsTun) useApp.setState({ tunEnabled: true });
    const message = restored ? null : '固定节点尚未确认，已保留现有连接，请检查后重新选择';
    useApp.setState({ kernelPhase: 'running', kernelError: message });
    if (message) useApp.getState().notify('error', message);
    await pushTray(useApp.getState());
  });
}

async function startFor(token: number, quiet: boolean, retry = true): Promise<void> {
  const current = () => lifecycle.current(token);
  if (!current()) return;
  if (!isTauri) {
    useApp.getState().notify('error', '浏览器预览模式无法启动内核，请用 npm run app 启动桌面端');
    return;
  }
  if (!preparedFor(useApp.getState())) {
    if (!useApp.getState().profiles.some(p => p.id === useApp.getState().activeId)) {
      useApp.getState().notify('error', '还没有订阅，先在「订阅」页导入一份');
      return;
    }
    const prepared = await useApp.getState().applyConfig();
    if (!current() || !prepared) return;
  }
  await lifecycle.serial(async () => {
    if (!current() || useApp.getState().kernelPhase === 'running') return;
    if (!preparedFor(useApp.getState())) return;
    const { configPath, dataDir, settings, tunEnabled, activeId } = useApp.getState();
    const restoreContext = restorationContextOf(useApp.getState());
    const routing = preparedRouting;
    useApp.setState({ kernelPhase: 'starting', kernelError: null });
    if (!quiet) useApp.getState().notify('info', '正在启动内核…');
    try {
      const st = await api.startKernel(configPath, dataDir || DATA_DIR, settings.kernelPath || null,
        tunEnabled, settings.controllerPort, settings.controllerSecret);
      if (!current()) return; // 已发出的启动由排队的停止清理。
      if (!st.running) throw new Error('内核未就绪，请检查内核路径或配置');
      useApp.setState({ connectedAt: Date.now(), kernelError: null, routing });
      if (st.reclaimed?.length) useApp.getState().notify('info', `已自动关闭 ${st.reclaimed.length} 个占用端口的进程`);
      const refreshed = await refreshFixedGroupsFor(token, activeId, restoreContext);
      if (!current()) return;
      if (!restorationCurrent(token, activeId, restoreContext) ||
          (Object.keys(useApp.getState().fixedNodes[activeId ?? ''] ?? {}).length
          && (!refreshed || !await restoreFixedNodesFor(token, activeId, restoreContext)))) {
        if (!current()) return;
        await api.stopKernel();
        if (!current()) return;
        throw new Error('固定节点恢复未确认，已停止本次连接，请检查节点后重试');
      }
      if (!current()) return;
      if (refreshed) await restoreSelectedNodesFor(token, activeId, restoreContext);
      if (!restorationCurrent(token, activeId, restoreContext)) return;
      useApp.setState({ kernelPhase: 'running' });
      if (!tunEnabled) {
        try {
          const sp = await enableSystemProxy(settings.mixedPort);
          if (!current()) return;
          useApp.setState({ sysProxyEnabled: sp.enabled });
          void persist(useApp.getState());
        } catch (e) {
          if (!current()) return;
          useApp.getState().notify('error', `内核已启动，但系统代理打开失败：${errorText(e)}`);
        }
      }
      if (!quiet) useApp.getState().notify('success', '已连接');
    } catch (e) {
      if (!current()) return;
      const msg = errorText(e);
      useApp.setState({ kernelPhase: 'failed', connectedAt: null, kernelError: msg });
      if (retry && /address already in use|没有监听/.test(msg)) {
        lifecycle.schedule(token, 1200, () => void startFor(token, true, false));
      } else {
        if (useApp.getState().sysProxyEnabled) {
          await disableProxyOnFailure(settings.mixedPort);
          if (!current()) return;
          useApp.setState({ sysProxyEnabled: false });
          void persist(useApp.getState());
        }
        if (!quiet) useApp.getState().notify('error', `启动内核失败：${msg}`);
      }
    }
    if (current()) await pushTray(useApp.getState());
  });
}

async function stopFor(token: number, quiet: boolean): Promise<void> {
  if (!lifecycle.current(token)) return;
  useApp.setState({ kernelPhase: 'stopping' });
  await lifecycle.serial(async () => {
    // 即便之后又请求连接，也要先收尾已经发出的启动和代理开启。
    const port = useApp.getState().settings.mixedPort;
    const actual = isAndroid ? null : await api.getSystemProxy().catch(() => null);
    if (!isAndroid && (!actual || actual.port === port || useApp.getState().ownedProxyPorts.includes(actual.port))) {
      try {
        await api.setSystemProxy(false, '127.0.0.1', actual?.port ?? port);
        useApp.setState({ ownedProxyPorts: [] });
        if (lifecycle.current(token)) {
          useApp.setState({ sysProxyEnabled: false });
          void persist(useApp.getState());
        }
      } catch (e) {
        if (lifecycle.current(token)) useApp.getState().notify('error', `关闭系统代理失败：${errorText(e)}`);
      }
    }
    try {
      await api.stopKernel();
      if (!lifecycle.current(token)) return;
      useApp.setState({ kernelPhase: 'stopped', connectedAt: null, groups: [], kernelError: null });
      if (!quiet) useApp.getState().notify('info', '已断开连接');
    } catch (e) {
      if (!lifecycle.current(token)) return;
      useApp.setState({ kernelPhase: 'failed', connectedAt: null, kernelError: `停止内核失败：${errorText(e)}` });
      if (!quiet) useApp.getState().notify('error', `停止内核失败：${errorText(e)}`);
    }
    if (lifecycle.current(token)) await pushTray(useApp.getState());
  });
}

/** 配置调用方沿用动作开始时的代次，不能让旧续体重新取得接管权。 */
export async function restartKernelFor(token: number, quiet = true, prepared = false): Promise<boolean> {
  const current = () => lifecycle.current(token);
  if (!current()) return false;
  if (!prepared) {
    const applied = await useApp.getState().applyConfig();
    if (!current() || !applied) return false;
  }
  if (!current() || !preparedFor(useApp.getState())) return false;
  // 内部停机保留本次代次；用户停止则会立即使它失效。
  await stopFor(token, true);
  if (!current() || useApp.getState().kernelPhase !== 'stopped') return false;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await new Promise(r => setTimeout(r, attempt === 1 ? 400 : 1200 * attempt));
    if (!current()) return false;
    await startFor(token, true, false);
    if (!current()) return false;
    if (useApp.getState().kernelPhase === 'running') {
      if (!quiet) useApp.getState().notify('success', '内核已重启');
      return true;
    }
  }
  useApp.getState().notify('error', '内核重启失败，详见 kernel.log');
  return false;
}

export { isGroupNode } from '../core/proxy-runtime';
function parseGroups(raw: unknown, publishGlobal = true, profileRaw?: string) {
  const state = useApp.getState();
  return parseRuntimeGroups(raw, profileRaw ?? state.profiles.find(profile => profile.id === state.activeId)?.raw ?? '',
    publishGlobal ? group => { globalGroup = group; } : undefined);
}

export { resolveEffectiveGroup } from '../core/effective-group';

export { resolveActiveNode } from '../core/active-node';

const persist = createStatePersistence({
  allowed: () => isTauri && !useApp.getState().persistenceFrozen,
  write: (payload, session) => api.saveAppState(payload, DATA_DIR, session),
  report: error => console.error('[PPClash] 状态落盘失败', error),
});

function configInputsOf(s: AppStore) { return configurationInputs(s, preparedInputs); }

/** 候选只借用生成输入，不提前替换订阅或修改活动身份。 */
function configInputsForProfile(s: AppStore, profile: Profile): ConfigInputs {
  return configInputsOf({ ...s, activeId: profile.id,
    profiles: s.profiles.map(p => p.id === profile.id ? profile : p),
    groups: s.activeId === profile.id ? s.groups : [] })!;
}

function profileRefreshInputKey(s: AppStore, profile: Profile): string {
  const inputs = configInputsForProfile(s, profile);
  // 手选节点允许在下载期间变化；提交时基于最新选择重新生成候选。
  return JSON.stringify({ ...inputs, runtime: { ...inputs.runtime, currentNode: '', selectedNodes: {} } });
}

async function validateImportedProfile(state: AppStore, profile: Profile, current: () => boolean) {
  validateSubscriptionCandidate(profile.raw);
  const inputs = configInputsForProfile({ ...state, profiles: [...state.profiles, profile] }, profile);
  const prepared = await prepareConfigCandidate(inputs, current);
  if (!prepared) throw new Error('操作状态已变化，请重新导入');
  try {
    if (!current()) throw new Error('操作状态已变化，请重新导入');
    return { audit: prepared.audit, stats: prepared.stats };
  } finally {
    await api.discardConfig(prepared.candidate);
  }
}

const publishTray = createTrayPublisher({
  enabled: () => isTauri && !isAndroid,
  primaryGroup: state => primaryRoutingGroup(state)?.name ?? '',
  write: (...flags) => api.setTrayFlags(...flags),
  report: error => console.error('[PPClash] 同步托盘失败', error),
});
const pushTray = (state: AppStore) => publishTray(state);

let toastSeq = 0;

export const useApp = create<AppStore>((set, get) => ({
  profiles: [],
  activeId: null,
  updateInfo: null,
  checkingUpdate: false,
  downloadingUpdate: false,
  updateError: null,
  updateCheckedAt: null,
  elevated: true,
  elevationPrompt: false,
  elevationBusy: false,
  policy: DEFAULT_POLICY,
  policyApplying: false,
  policyError: null,
  settings: { ...DEFAULT_SETTINGS, textSize: currentTextSize() },
  tunEnabled: false,
  sysProxyEnabled: false,
  ownedProxyPorts: [],
  kernelPhase: 'stopped',
  connectedAt: null,
  kernelError: null,
  groups: [],
  proxyRuntime: null,
  routing: null,
  routeRevision: 0,
  runtimeConfigRevision: 0,
  runtimeConfigTransition: false,
  persistenceFrozen: false,
  restoredStatePending: false,
  restoringBackup: false,
  pinnedNodes: {},
  fixedNodes: {},
  selectedNodes: {},
  audit: [],
  stats: null,
  toast: null,
  busy: false,
  importing: false,
  importStage: null,
  activatingProfile: false,
  refreshingIds: [],
  profileRefreshErrors: {},
  configPath: '',
  dataDir: '',

  checkUpdate: async (silent = false) => {
    if (!isTauri || get().checkingUpdate || get().downloadingUpdate) return;
    set({ checkingUpdate: true, updateError: null });
    try {
      const info = await api.checkGithubUpdate(UPDATE_REPO, APP_VERSION);
      set({ updateInfo: info, checkingUpdate: false, updateCheckedAt: Date.now() });
      if (!silent) {
        if (info) get().notify('info', `发现新版本 ${info.version}`);
        else get().notify('success', '已是最新版本');
      }
    } catch (e) {
      set({ checkingUpdate: false, updateInfo: null, updateError: errorText(e) });
      if (!silent) get().notify('error', `检查更新失败：${errorText(e)}`);
    }
  },

  downloadUpdate: async () => {
    const info = get().updateInfo;
    if (!info || get().downloadingUpdate) return;
    if (!info.sha256) {
      get().notify('error', '更新源未提供 sha256，出于安全考虑已拒绝下载');
      return;
    }
    set({ downloadingUpdate: true });
    let downloaded = false;
    try {
      const path = await api.downloadAppUpdate(info.url, info.sha256);
      downloaded = true;
      await api.openDownloadedUpdate(path);
      get().notify('success', isAndroid ? '请在系统安装器中确认更新' : `更新包已下载：${info.version}`);
      set({ downloadingUpdate: false });
    } catch (e) {
      set({ downloadingUpdate: false });
      get().notify('error', `${downloaded ? '无法安装更新' : '下载更新失败'}：${errorText(e)}`);
    }
  },

  dismissUpdate: () => set({ updateInfo: null }),

  confirmElevation: async () => {
    if (get().elevationBusy) return;
    set({ elevationBusy: true, elevationPrompt: false, tunEnabled: true });
    await persist(get());
    try {
      await api.restartAsAdmin();
    } catch (e) {
      set({ elevationBusy: false, tunEnabled: false });
      await persist(get());
      get().notify('error', `请求管理员权限失败：${errorText(e)}`);
    }
  },

  cancelElevation: () => {
    set({ elevationPrompt: false, elevationBusy: false, tunEnabled: false });
    void persist(get());
  },

  notify: (kind, text) => {
    if (kind === 'error') logEvent('error', text);
    const cur = get().toast;
    // 同一条消息重复出现时不刷新，避免轮询失败把 toast 钉死
    if (cur && cur.kind === kind && cur.text === text) return;
    set({ toast: { id: ++toastSeq, kind, text } });
  },

  clearToast: () => set({ toast: null }),

  restoreBackup: async (backup) => {
    if (get().persistenceFrozen) throw new Error('状态正在读取或恢复，请稍后重试');
    set({ persistenceFrozen: true, restoringBackup: true });
    persistenceRevision++;
    try {
      if (typeof backup === 'string') {
        await api.restoreBackup(DATA_DIR, backup);
      } else {
        const session = get().persistenceSession;
        if (!session) throw new Error('请在应用载入完成后恢复');
        if ('savedWebDav' in backup) await webdavService.restore({ name: backup.name, passphrase: backup.passphrase, digest: backup.digest, session });
        else await api.webdavRestore(backup, session);
      }
      // 恢复成功后旧内存保持只读，只有完整水合恢复态才重新获得写权限。
      set({ persistenceSession: undefined, persistenceFrozen: true, restoredStatePending: true, restoringBackup: false });
    } catch (error) {
      set({ persistenceFrozen: false, restoringBackup: false });
      await persist(get());
      throw error;
    }
  },

  hydrate: async () => {
    if (!isTauri || get().restoringBackup) return;
    const token = lifecycle.token();
    const request = ++hydrationRequest;
    const revision = persistenceRevision;
    set({ persistenceFrozen: true });
    const session = crypto.randomUUID();
    const current = () => lifecycle.current(token) && request === hydrationRequest && revision === persistenceRevision;
    const appearanceRevision = textSizeRevision();
    try {
      const elevated = isAndroid || await api.isElevated().catch(() => true);
      if (!current()) return;
      set({ elevated });
      const raw = await api.loadAppState(DATA_DIR, session);
      if (!current()) return;
      const saved = raw ? (JSON.parse(raw) as Partial<AppStore>) : {};

      const rawSettings = (saved.settings ?? {}) as Partial<AppSettings> &
        Record<string, unknown>;
      const settings: AppSettings = { ...DEFAULT_SETTINGS, ...rawSettings };
      delete (settings as AppSettings & Record<string, unknown>).egressGuard;
      delete (settings as AppSettings & Record<string, unknown>).egressGuardNode;
      settings.textSize = normalizeTextSize(rawSettings.textSize);
      // v2：进阶功能默认开启（老用户只迁移一次，之后尊重用户选择）
      const savedVersion = typeof rawSettings.settingsVersion === 'number'
        ? rawSettings.settingsVersion
        : 0;
      if (savedVersion < 2) {
        settings.advancedMode = true;
        settings.settingsVersion = 2;
      }
      // v3：嗅探提升为默认最佳配置；只迁移一次，之后尊重用户开关。
      if (savedVersion < 3) {
        settings.snifferEnabled = true;
        settings.snifferOverrideDestination = false;
        settings.settingsVersion = 3;
      }
      // 兼容旧版单文件覆写（overrideEnabled / overrideMode / overrideText）
      if (!Array.isArray(settings.overrides)) settings.overrides = [];
      const rawRules = rawSettings.customRules;
      if (Array.isArray(rawRules)) {
        settings.customRules = rawRules.map((r: unknown, i: number) => {
          if (r && typeof r === 'object') {
            const o = r as Partial<CustomRule>;
            return {
              id: o.id ?? `rule-${i}`,
              type: o.type ?? 'DOMAIN-SUFFIX',
              payload: o.payload ?? '',
              target: o.target ?? 'DIRECT',
              enabled: o.enabled !== false,
            };
          }
          const line = String(r);
          const [type = 'DOMAIN-SUFFIX', payload = '', target = 'DIRECT'] = line
            .split(',')
            .map((x) => x.trim());
          return {
            id: `rule-${i}`,
            type: type || 'DOMAIN-SUFFIX',
            payload,
            target: target || 'DIRECT',
            enabled: true,
          };
        });
      } else {
        settings.customRules = [];
      }
      const legacyText = rawSettings.overrideText;
      if (settings.overrides.length === 0 && typeof legacyText === 'string' && legacyText.trim()) {
        settings.overrides = [
          {
            id: 'legacy',
            name: '覆写',
            mode: rawSettings.overrideMode === 'js' ? 'js' : 'yaml',
            enabled: Boolean(rawSettings.overrideEnabled),
            text: legacyText,
          },
        ];
      }
      const policy: SecurityPolicy = { ...DEFAULT_POLICY, ...(saved.policy ?? {}) };

      // 旧版 state.json 里的订阅没有 userinfo，这里补默认值，避免 UI 崩溃
      const profiles: Profile[] = (saved.profiles ?? []).map((p) => ({
        ...p,
        userinfo: p.userinfo ?? null,
        updateIntervalHours: p.updateIntervalHours ?? null,
      }));

      settings.geoUrls = {
        ...DEFAULT_SETTINGS.geoUrls,
        ...(settings.geoUrls ?? {}),
      };
      if (!settings.geoUrls.geoip) settings.geoUrls.geoip = DEFAULT_SETTINGS.geoUrls.geoip;
      if (!settings.geoUrls.geosite) settings.geoUrls.geosite = DEFAULT_SETTINGS.geoUrls.geosite;
      if (!settings.geoUrls.mmdb) settings.geoUrls.mmdb = DEFAULT_SETTINGS.geoUrls.mmdb;
      if (!settings.geoUrls.asn) settings.geoUrls.asn = DEFAULT_SETTINGS.geoUrls.asn;
      if (!settings.geoUrls.country) settings.geoUrls.country = DEFAULT_SETTINGS.geoUrls.country;
      if (!settings.controllerSecret.trim()) {
        const bytes = new Uint8Array(18);
        crypto.getRandomValues(bytes);
        settings.controllerSecret = Array.from(bytes, (b) =>
          b.toString(16).padStart(2, '0')
        ).join('');
      }
      setMihomoSecret(settings.controllerSecret);
      settings.textSize = restoreTextSize(rawSettings.textSize, appearanceRevision);
      set({
        profiles,
        activeId: saved.activeId ?? null,
        policy,
        settings,
        tunEnabled: !isAndroid && (saved.tunEnabled ?? false),
        sysProxyEnabled: !isAndroid && (saved.sysProxyEnabled ?? false),
        pinnedNodes: saved.pinnedNodes ?? {},
        fixedNodes: normalizeFixedNodes(saved.fixedNodes, profiles),
        selectedNodes: normalizeFixedNodes(saved.selectedNodes, profiles),
        persistenceSession: session,
        persistenceFrozen: false,
        restoredStatePending: false,
      });
      // 首次生成 controller secret 必须落盘，否则下次启动会生成新的，
      // 与已生成配置里的 secret 不一致，内核 API 会 401。
      await persist(get());
      if (!current()) return;
      setMihomoBase(settings.controllerPort);
      const desiredTun = saved.tunEnabled ?? false;
      const desiredSysProxy = saved.sysProxyEnabled ?? false;

      // 老版本导入的订阅没有订阅名和流量信息：后台补一次响应头（失败静默）
      const active = profiles.find((p) => p.id === saved.activeId);
      if (active && active.sourceType !== 'collection' && !active.userinfo) {
        void get().refreshProfile(active.id, true);
      }

      // 主题立即生效（与 theme store 同步）
      useTheme.getState().setMode(settings.theme);

      // 若仍有活动订阅，按当前策略/端口重建配置文件，保证磁盘与内存一致
      const stillValid =
        saved.activeId && (saved.profiles ?? []).some((p) => p.id === saved.activeId);
      if (stillValid) {
        await get().applyConfig();
        if (!current()) return;
      }

      // 内核可能在应用上次退出后仍在运行（或用户外部启动过），以实际探测为准
      const st = await api.kernelStatus(settings.controllerSecret).catch(() => null);
      if (!current()) return;
      if (st?.running) {
        await adoptRunningKernelFor(token, isAndroid || desiredTun, !isAndroid && desiredSysProxy && !desiredTun);
        if (!current()) return;
      } else if (!isAndroid && st?.running === false) {
        // 上次崩溃/强退可能留下 TUN 内核：不清掉会把系统流量继续劫持走
        void api.cleanupStaleKernel().catch(() => null);
      }

      // 系统代理的真实状态以 networksetup 为准（用户可能在系统设置里改过）
      const sp = st?.running || isAndroid ? null : await api.getSystemProxy().catch(() => null);
      if (!current()) return;
      if (sp) {
        if (sp.enabled && sp.port === settings.mixedPort) rememberProxyPort(sp.port);
        set({ sysProxyEnabled: sp.enabled });
        if (sp.enabled && st?.running === false) {
          if (sp.port === get().settings.mixedPort) {
            // 上次退出时内核被强杀/崩溃，系统代理指向了已经不存在的端口：
            // 这会表现为「电脑断网」，必须自动撤掉。
            await api
              .setSystemProxy(false, '127.0.0.1', get().settings.mixedPort)
              .catch(() => null);
            if (!current()) return;
            set({ sysProxyEnabled: false });
            get().notify('info', '已关闭遗留的系统代理');
          } else {
            // 别的客户端设置的代理不动它，只提示
            get().notify(
              'info',
              `系统代理指向 127.0.0.1:${sp.port}，连接后切换`
            );
          }
        }
      }

      // 关窗行为/托盘网速/Dock 设置需要同步到 Rust，否则重启后首帧使用旧默认值
      if (isTauri && !isAndroid) {
        void api.setCloseToTray(settings.closeToTray).catch(() => null);
      }

      // 状态记忆：上次开启的系统代理/TUN，启动后自动恢复。
      const wantsTun = desiredTun;
      const wantsSysProxy = desiredSysProxy && !desiredTun;
      if (!isAndroid && st?.running === false && get().activeId) {
        if (wantsTun && isWindows && !elevated) {
          // Windows TUN 需要管理员：先弹确认框，确认后 UAC 重启应用再自动恢复。
          set({ tunEnabled: false, sysProxyEnabled: false, elevationPrompt: true });
          get().notify('info', '上次开启了 TUN，需要管理员权限才能恢复');
        } else if (wantsTun) {
          set({ tunEnabled: true, sysProxyEnabled: false });
          lifecycle.schedule(token, 600, () => void startFor(token, true));
          get().notify('info', '正在恢复上次的 TUN 接管');
        } else if (wantsSysProxy) {
          set({ tunEnabled: false, sysProxyEnabled: false });
          lifecycle.schedule(token, 600, () => void startFor(token, true));
          get().notify('info', '正在恢复上次的系统代理');
        }
      }

      await pushTray(get());
      if (settings.updateCheckOnLaunch) {
        window.setTimeout(() => void get().checkUpdate(true), 1200);
      }
    } catch (e) {
      if (!current()) return;
      console.error('[PPClash] 水合失败', e);
      get().notify('error', `读取本地状态失败：${errorText(e)}`);
    } finally {
      // 生命周期作废也需释放普通读取的冻结，但只能由最新持有者释放；
      // 恢复已替换磁盘时，失败/取消读取必须保留恢复屏障。
      if (request === hydrationRequest && revision === persistenceRevision && get().persistenceFrozen
          && !get().restoringBackup && !get().restoredStatePending) {
        set({ persistenceFrozen: false });
        // 首次读取失败时内存尚未水合，不能用默认空状态自动覆盖原磁盘。
        if (get().persistenceSession) await persist(get());
      }
    }
  },

  importProfile: async (url, useProxy = false) => {
    const token = lifecycle.token();
    if (!isTauri) {
      set({ toast: { id: ++toastSeq, kind: 'error', text: '浏览器预览模式无法拉取订阅，请用 npm run app 启动桌面端' } });
      return false;
    }
    if (get().importing) return false;
    try { url = normalizeSubscriptionUrl(url); }
    catch (error) { get().notify('error', errorText(error)); return false; }
    if (get().profiles.some(p => p.sourceType !== 'file' && sameSubscriptionUrl(p.url, url))) {
      get().notify('info', '此订阅已添加，请使用已有订阅');
      return false;
    }
    set({ busy: true, importing: true, importStage: 'fetching' });
    try {
      const proxyPort =
        useProxy && get().kernelPhase === 'running' ? get().settings.mixedPort : undefined;
      if (useProxy && get().kernelPhase !== 'running') {
        get().notify('info', '内核未运行，直连导入');
      }
      const payload = await api.fetchSubscription(url, proxyPort);
      if (!lifecycle.current(token)) throw new Error('操作状态已变化，请重新导入');
      const meta = parseSubscriptionMeta(payload);
      const id = crypto.randomUUID();
      const profile: Profile = {
        id,
        // 机场在响应头里给的真名优先（如「Example Air」），拿不到才用域名
        name: meta.name ?? nameFromUrl(url),
        url,
        raw: payload.raw,
        updatedAt: Date.now(),
        userinfo: meta.traffic,
        updateIntervalHours: meta.updateIntervalHours,
        autoUpdateHours: null,
        useProxy,
        sourceType: 'url',
      };
      set({ importStage: 'validating' });
      const { audit, stats } = await validateImportedProfile(get(), profile, () => lifecycle.current(token));
      if (!lifecycle.current(token)) throw new Error('操作状态已变化，请重新导入');
      set((s) => {
        const hasActive = s.profiles.some(p => p.id === s.activeId);
        return { profiles: [...s.profiles, profile], activeId: hasActive ? s.activeId : id,
          ...(!hasActive ? { audit, stats } : {}) };
      });
      void persist(get());
      // 新增订阅不打断当前订阅；首次导入才需要生成当前配置。
      if (get().activeId === id && lifecycle.current(token)) {
        set({ importStage: 'applying' });
        const applied = await get().applyConfig();
        const ready = applied && lifecycle.current(token) && (get().kernelPhase !== 'running' || await get().restartKernel(true, token, true));
        if (!ready) {
          get().notify('error', '订阅已保存，但配置未应用，请检查配置后重新连接');
          return true;
        }
      }
      const realNodes = countRealNodes(payload.raw);
      get().notify(
        'success',
        `订阅已导入${meta.name ? ` · ${meta.name}` : ''}${realNodes ? ` · ${realNodes} 个节点` : ''}`
      );
      return true;
    } catch (e) {
      get().notify('error', `导入失败：${errorText(e)}`);
      return false;
    } finally {
      set({ busy: configPending > 0, importing: false, importStage: null });
    }
  },

  saveCollection: async (name, recipe, id) => {
    if (!name.trim() || name.length > 80) throw new Error('请输入不超过 80 字的组合名称');
    const before = get();
    if (before.busy || before.importing || before.activatingProfile || before.persistenceFrozen) throw new Error('请稍后重试');
    if (id && before.activeId === id) throw new Error('请先切换到其他订阅，再编辑正在使用的组合');
    const original = id ? before.profiles.find(p => p.id === id) : undefined;
    if (id && original?.sourceType !== 'collection') throw new Error('订阅组合不存在');
    const sources = collectionSources(before.profiles, recipe);
    const token = lifecycle.token();
    const current = () => lifecycle.current(token) && !get().persistenceFrozen && before.persistenceSession === get().persistenceSession
      && sources.every(s => get().profiles.find(p => p.id === s.id) === s)
      && (!id || (get().activeId !== id && get().profiles.find(p => p.id === id) === original));
    set({ importing: true, busy: true, importStage: 'validating' });
    try {
      const { raw } = await buildCollection(sources, recipe, false);
      if (!current()) throw new Error('来源订阅已变化，请重试');
      const profile: Profile = { ...original, id: id ?? crypto.randomUUID(), name: name.trim(), sourceType: 'collection',
        url: '', raw, updatedAt: Date.now(), userinfo: null, updateIntervalHours: null, collection: recipe };
      await validateImportedProfile(get(), profile, current);
      if (!current()) throw new Error('来源订阅已变化，请重试');
      set(s => ({ profiles: id ? s.profiles.map(p => p.id === id ? profile : p) : [...s.profiles, profile] }));
      await persist(get());
    } finally { set({ importing: false, busy: configPending > 0, importStage: null }); }
  },

  renameSubStoreReferences: async ({ kind, oldName, newName }) => {
    const before = get();
    if (oldName === newName) return;
    if (!newName.trim() || newName.length > 256 || !['sub', 'collection'].includes(kind)) throw new Error('Sub-Store 来源名称无效');
    const linked = before.profiles.filter(profile => profile.subStore?.kind === kind && profile.subStore.name === oldName);
    if (!linked.length) return;
    if (before.busy || before.importing || before.activatingProfile || before.persistenceFrozen) throw new Error('应用状态正在处理，无法修改来源关联');
    const token = lifecycle.token();
    const current = () => lifecycle.current(token) && !get().persistenceFrozen && before.persistenceSession === get().persistenceSession;
    set({ busy: true });
    const ids = new Set(linked.map(profile => profile.id));
    set(s => ({ profiles: s.profiles.map(profile => ids.has(profile.id) ? { ...profile, subStore: { kind, name: newName } } : profile) }));
    try {
      await persist(get(), true);
      if (!current()) throw new Error('状态会话已变化，请重新检查来源关联');
    } catch (error) {
      if (current()) set(s => ({ profiles: s.profiles.map(profile => ids.has(profile.id) && profile.subStore?.name === newName
        ? { ...profile, subStore: { kind, name: oldName } } : profile) }));
      throw error;
    } finally { if (current()) set({ busy: configPending > 0 }); }
  },

  addSubStoreProfile: async (name, reference, raw) => {
    name = name.trim();
    if (!name || name.length > 80 || !['sub', 'collection'].includes(reference.kind)
      || !reference.name.trim() || reference.name.length > 256) throw new Error('请输入有效的订阅名称与 Sub-Store 来源');
    const before = get();
    if (before.busy || before.importing || before.activatingProfile || before.persistenceFrozen) throw new Error('状态正在处理，请稍后重试');
    if (before.profiles.some(p => p.subStore?.kind === reference.kind && p.subStore.name === reference.name)) {
      throw new Error('此 Sub-Store 来源已添加，请更新已有订阅');
    }
    const token = lifecycle.token();
    const current = () => lifecycle.current(token) && !get().persistenceFrozen && before.persistenceSession === get().persistenceSession;
    set({ importing: true, busy: true, importStage: 'validating' });
    try {
      const profile: Profile = { id: crypto.randomUUID(), name, url: '', raw, sourceType: 'substore',
        subStore: { ...reference }, updatedAt: Date.now(), userinfo: null, updateIntervalHours: null };
      await validateImportedProfile(get(), profile, current);
      if (!current()) throw new Error('操作状态已变化，请重新导入');
      set(s => ({ profiles: [...s.profiles, profile] }));
      try { await persist(get(), true); }
      catch (error) {
        if (current()) set(s => ({ profiles: s.profiles.filter(item => item.id !== profile.id) }));
        throw error;
      }
    } finally { set({ importing: false, busy: configPending > 0, importStage: null }); }
  },

  importProfileFile: async (path) => {
    const token = lifecycle.token();
    if (!isTauri) {
      set({ toast: { id: ++toastSeq, kind: 'error', text: '浏览器预览模式无法读取本地文件' } });
      return false;
    }
    if (get().importing) return false;
    path = path.trim();
    if (!path) { get().notify('error', '请选择本地配置文件'); return false; }
    if (get().profiles.some(p => p.sourceType === 'file' && p.url === path)) {
      get().notify('info', '此文件已添加，请使用已有订阅');
      return false;
    }
    set({ busy: true, importing: true, importStage: 'fetching' });
    try {
      const raw = await api.readSubscriptionFile(path);
      if (!lifecycle.current(token)) throw new Error('操作状态已变化，请重新导入');
      const id = crypto.randomUUID();
      const profile: Profile = {
        id,
        name: nameFromPath(path),
        url: path,
        raw,
        updatedAt: Date.now(),
        userinfo: null,
        updateIntervalHours: null,
        autoUpdateHours: 0,
        useProxy: false,
        sourceType: 'file',
      };
      set({ importStage: 'validating' });
      const { audit, stats } = await validateImportedProfile(get(), profile, () => lifecycle.current(token));
      if (!lifecycle.current(token)) throw new Error('操作状态已变化，请重新导入');
      set((s) => {
        const hasActive = s.profiles.some(p => p.id === s.activeId);
        return { profiles: [...s.profiles, profile], activeId: hasActive ? s.activeId : id,
          ...(!hasActive ? { audit, stats } : {}) };
      });
      void persist(get());
      // 新增订阅不打断当前订阅；首次导入才需要生成当前配置。
      if (get().activeId === id && lifecycle.current(token)) {
        set({ importStage: 'applying' });
        const applied = await get().applyConfig();
        const ready = applied && lifecycle.current(token) && (get().kernelPhase !== 'running' || await get().restartKernel(true, token, true));
        if (!ready) {
          get().notify('error', '订阅已保存，但配置未应用，请检查配置后重新连接');
          return true;
        }
      }
      const realNodes = countRealNodes(raw);
      get().notify(
        'success',
        `本地订阅已导入${realNodes ? ` · ${realNodes} 个节点` : ''}`
      );
      return true;
    } catch (e) {
      get().notify('error', `导入失败：${errorText(e)}`);
      return false;
    } finally {
      set({ busy: configPending > 0, importing: false, importStage: null });
    }
  },

  activate: async (id) => {
    const token = lifecycle.token();
    const before = get();
    const p = before.profiles.find((x) => x.id === id);
    if (!p || before.activeId === id || before.activatingProfile || before.importing) return;
    set({ activatingProfile: true });
    try {
      const { audit, stats } = await generateConfig(p.raw, get().policy, runtimeOf(get()), overrideOf(get()), p.ruleEdits);
      if (!lifecycle.current(token)) return;
      set({ activeId: id, audit, stats });
      const applied = await get().applyConfig();
      if (!lifecycle.current(token)) return;
      if (!applied) {
        set({ activeId: before.activeId, audit: before.audit, stats: before.stats, configPath: before.configPath });
        get().notify('error', '订阅配置生成失败，保留原订阅');
        return;
      }
      void persist(get());
      if (lifecycle.current(token) && get().kernelPhase === 'running' && !await get().restartKernel(true, token, true)) {
        if (get().kernelPhase === 'running') {
          set({ activeId: before.activeId, audit: before.audit, stats: before.stats, configPath: '', routing: before.routing });
          void persist(get());
          get().notify('error', '新订阅未能应用，继续使用原订阅');
        }
        return;
      }
      get().notify('info', `已切换到 ${p.name}`);
    } catch (error) {
      get().notify('error', `切换订阅失败：${errorText(error)}`);
    } finally {
      set({ activatingProfile: false });
    }
  },

  removeProfile: async (id) => {
    const wasActive = get().activeId === id;
    set((s) => ({
      profiles: s.profiles.filter((p) => p.id !== id),
      fixedNodes: Object.fromEntries(Object.entries(s.fixedNodes).filter(([profileId]) => profileId !== id)),
      selectedNodes: Object.fromEntries(Object.entries(s.selectedNodes).filter(([profileId]) => profileId !== id)),
      // 删掉活动订阅后配置链路失效，清空派生状态
      ...(wasActive ? { activeId: null, audit: [], stats: null, groups: [] } : {}),
    }));
    if (wasActive && get().kernelPhase === 'running') {
      await get().stopKernel(true);
      get().notify('info', '订阅已删除');
    }
    void persist(get());
  },

  updateProfile: (id, patch) => {
    set((s) => ({
      profiles: s.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }));
    void persist(get());
  },

  updateRuleEdits: async (edits) => {
    const token = lifecycle.token();
    const id = get().activeId;
    if (!id) return;
    set((s) => ({
      profiles: s.profiles.map((p) => (p.id === id ? { ...p, ruleEdits: edits } : p)),
    }));
    void persist(get());
    const st = get();
    const applied = await st.applyConfig();
    if (!lifecycle.current(token)) return;
    if (!applied) {
      get().notify('error', '订阅规则已保存但配置生成失败，未应用');
      return;
    }
    if (st.kernelPhase === 'running') {
      const ok = await get().restartKernel(true, token, true);
      if (!ok) return;
    }
    get().notify('success', '订阅规则已更新');
  },

  reorderProfiles: (fromId, toId) => {
    const profiles = [...get().profiles];
    const from = profiles.findIndex((p) => p.id === fromId);
    const to = profiles.findIndex((p) => p.id === toId);
    if (from < 0 || to < 0 || from === to) return;
    const [item] = profiles.splice(from, 1);
    profiles.splice(to, 0, item);
    set({ profiles });
    void persist(get());
  },

  moveProfile: (id, dir) => {
    const profiles = [...get().profiles];
    const index = profiles.findIndex((p) => p.id === id);
    const target = index + dir;
    if (index < 0 || target < 0 || target >= profiles.length) return;
    [profiles[index], profiles[target]] = [profiles[target], profiles[index]];
    set({ profiles });
    void persist(get());
  },

  refreshProfile: (id, quiet = false) => {
    const pending = profileRefreshes.get(id);
    if (pending) return pending;
    const token = lifecycle.token();
    const before = get();
    const p = before.profiles.find(x => x.id === id);
    if (!p || !isTauri) return Promise.resolve(false);
    if (p.sourceType === 'file' && !p.url) {
      if (!quiet) before.notify('info', '已恢复订阅内容。请先在编辑订阅中选择本机文件，再更新。');
      return Promise.resolve(false);
    }
    const dependencies = p.collection?.sources.map(key => before.profiles.find(source => source.id === key));
    const sourceKey = profileRefreshInputKey(before, p);
    let stale = false;
    let request: number | undefined;
    // 记录经过的变化，A→B→A 也不能让旧下载重新取得提交权。
    const unsubscribe = useApp.subscribe(s => {
      if (dependencies?.some(source => !source || s.profiles.find(x => x.id === source.id)?.url !== source.url) || s.profiles.find(x => x.id === id) !== p || s.activeId !== before.activeId
        || s.kernelPhase !== before.kernelPhase || s.connectedAt !== before.connectedAt
        || profileRefreshInputKey(s, p) !== sourceKey) stale = true;
    });
    const current = () => !stale && lifecycle.current(token) && (request === undefined || request === configRequest);
    const run = (async () => {
      let candidate: string | undefined;
      let counted = false;
      let stage = '下载订阅';
      let rollbackFailure = '';
      set(s => ({ refreshingIds: [...s.refreshingIds.filter(x => x !== id), id],
        profileRefreshErrors: Object.fromEntries(Object.entries(s.profileRefreshErrors).filter(([key]) => key !== id)) }));
      try {
        if (p.useProxy && before.kernelPhase !== 'running' && !quiet) get().notify('info', '内核未运行，直连更新');
        const proxyPort = p.useProxy && before.kernelPhase === 'running' ? before.settings.mixedPort : undefined;
        const payload = p.sourceType === 'substore' && p.subStore
          ? { raw: await downloadSubStoreProfile(p.subStore, proxyPort),
              profileTitle: null, contentDisposition: null, subscriptionUserinfo: null, profileUpdateInterval: null }
          : p.sourceType === 'collection' && p.collection
          ? { raw: (await buildCollection(collectionSources(before.profiles, p.collection), p.collection, true,
              before.kernelPhase === 'running' ? before.settings.mixedPort : undefined)).raw, profileTitle: null,
              contentDisposition: null, subscriptionUserinfo: null, profileUpdateInterval: null }
          : p.sourceType === 'file'
          ? { raw: await api.readSubscriptionFile(p.url), profileTitle: null, contentDisposition: null,
            subscriptionUserinfo: null, profileUpdateInterval: null }
          : await api.fetchSubscription(p.url, proxyPort);
        if (!current()) return false;
        stage = '检查订阅结构';
        validateSubscriptionCandidate(payload.raw);
        const meta = parseSubscriptionMeta(payload);
        const nextProfile = { ...p, raw: payload.raw, name: meta.name ?? p.name,
          userinfo: meta.traffic ?? p.userinfo, updateIntervalHours: meta.updateIntervalHours ?? p.updateIntervalHours };
        let applied = false;
        // 选择变化时重新校验候选；有界重试避免持续操作造成无限更新。
        for (let attempt = 0; attempt < 3; attempt++) {
          if (!current()) return false;
          const inputs: ConfigInputs = JSON.parse(JSON.stringify(configInputsForProfile(get(), nextProfile)));
          stage = '生成或校验配置';
          const prepared = await prepareConfigCandidate(inputs, current);
          if (!prepared) return false;
          candidate = prepared.candidate;
          if (!current()) return false;
          const publishProfile = () => {
            unsubscribe();
            set(s => ({ profiles: s.profiles.map(x => x.id === id ? { ...x, ...nextProfile, updatedAt: Date.now() } : x) }));
          };
          if (before.activeId !== id) {
            publishProfile();
          } else {
            request = ++configRequest;
            const runCommit = configCommitChain.then(() => lifecycle.serial(async () => {
              if (!current()) return false;
              const selectionKey = JSON.stringify(inputs);
              if (JSON.stringify(configInputsForProfile(get(), nextProfile)) !== selectionKey) return 'retry' as const;
              // 下载与独立候选校验不占全局操作锁，仅最终提交需要串行保护。
              configPending += 1; counted = true; set({ busy: true });
              const ownsRequest = () => current() && JSON.stringify(configInputsForProfile(get(), nextProfile)) === selectionKey;
              if (!ownsRequest()) return false;
              // 固定节点不能因新订阅缺失或覆写被静默移除，再把默认节点当成更新成功。
              stage = '检查固定节点';
              const candidateGroups = JSON.parse(prepared.config)['proxy-groups'] ?? [];
              const fixedSelections = { ...inputs.runtime.fixedNodes };
              for (const [group, node] of Object.entries(fixedSelections)) {
                if (!candidateGroups.some((g: any) => g.name === group && g.type === 'select'
                  && g['default-selected'] === node)) {
                  throw new Error(`候选订阅未保留固定节点「${group} / ${node}」`);
                }
              }
              const receipt = candidate!;
              stage = '提交配置';
              const absConfig = await api.commitConfig(receipt);
              candidate = undefined;
              let attemptedLoad = false;
              const base = `http://127.0.0.1:${before.settings.controllerPort}`;
              const secret = before.settings.controllerSecret;
              const rememberedSelections = Object.fromEntries(Object.entries(inputs.runtime.selectedNodes)
                .filter(([group]) => !Object.hasOwn(fixedSelections, group)));
              const reload = () => api.mihomo('PUT', '/configs?force=true', { path: absConfig }, base, secret);
              const sameSession = () => lifecycle.current(token) && get().kernelPhase === 'running'
                && get().connectedAt === before.connectedAt;
              const rollback = async () => {
                try {
                  await api.finishConfig(receipt, true);
                  // 超时可能发生在内核已接受之后；旧文件恢复后明确恢复旧运行版本。
                  if (attemptedLoad && sameSession()) {
                    set(s => ({ runtimeConfigRevision: s.runtimeConfigRevision + 1 }));
                    const rollbackRevision = get().runtimeConfigRevision;
                    const ownsRollback = () => sameSession() && get().activeId === id
                      && get().runtimeConfigRevision === rollbackRevision;
                    await reload();
                    if (ownsRollback()) {
                      const previous = await api.mihomo('GET', '/proxies', undefined, base, secret);
                      const restored = await restoreProxySelections(previous,
                        { ...inputs.runtime.selectedNodes, ...fixedSelections }, base, secret, ownsRollback);
                      if (!ownsRollback()) return;
                      const groups = parseGroups(restored, false, p.raw);
                      for (const [group, node] of Object.entries(fixedSelections)) {
                        const loaded = groups.find(g => g.name === group);
                        if (loaded?.type !== 'Selector' || loaded.now !== node
                          || !loaded.nodes.some(n => n.name === node && !isGroupNode(n, groups))) {
                          throw new Error(`内核未确认原固定节点「${group} / ${node}」`);
                        }
                      }
                      parseGroups(restored, true, p.raw);
                      set(s => ({ groups, proxyRuntime: { profileId: id, revision: rollbackRevision,
                        connectedAt: s.connectedAt, proxies: (restored as { proxies: Record<string, unknown> }).proxies },
                        routeRevision: s.routeRevision + 1 }));
                      void pushTray(get());
                    }
                  }
                } catch (error) {
                  rollbackFailure = errorText(error);
                  const stillCurrent = current();
                  const sessionUnknown = sameSession();
                  validatedRevision = -1; validatedPath = ''; preparedInputKey = ''; preparedRouting = null;
                  if (sessionUnknown) globalGroup = undefined;
                  set(s => ({ configPath: '', audit: [], stats: null,
                    ...(sessionUnknown ? { groups: [], routing: null, routeRevision: s.routeRevision + 1,
                      kernelError: '订阅更新回退未确认，请检查运行配置后重新连接' } : {}),
                    ...(stillCurrent ? { profileRefreshErrors: { ...s.profileRefreshErrors,
                      [id]: `回退配置失败：${rollbackFailure}；已保留原订阅内容，运行状态未确认` } } : {}) }));
                  stage = '回退配置';
                  get().notify('error', `订阅更新回退未确认：${errorText(error)}；已保留原订阅，请检查后重新连接`);
                }
              };
              try {
                if (!ownsRequest()) { await rollback(); return false; }
                let observed: unknown;
                if (before.kernelPhase === 'running') {
                  stage = '加载配置';
                  attemptedLoad = true;
                  set(s => ({ runtimeConfigRevision: s.runtimeConfigRevision + 1, runtimeConfigTransition: true }));
                  await reload();
                  if (!ownsRequest()) { await rollback(); return false; }
                  stage = '确认运行节点';
                  observed = await api.mihomo('GET', '/proxies', undefined, base, secret);
                  if (!ownsRequest()) { await rollback(); return false; }
                  observed = await restoreProxySelections(observed, rememberedSelections, base, secret, ownsRequest);
                  if (!ownsRequest()) { await rollback(); return false; }
                  const loadedGroups = parseGroups(observed, false, nextProfile.raw);
                  for (const [group, node] of Object.entries(fixedSelections)) {
                    const loaded = loadedGroups.find(g => g.name === group);
                    if (loaded?.type !== 'Selector' || loaded.now !== node
                      || !loaded.nodes.some(n => n.name === node && !isGroupNode(n, loadedGroups))) {
                      throw new Error(`内核未确认固定节点「${group} / ${node}」`);
                    }
                  }
                }
                // 同步接受候选与派生配置；之后的收尾不再撤销已发布版本。
                unsubscribe();
                configRevision += 1; validatedRevision = configRevision; validatedPath = absConfig;
                preparedInputs = inputs; preparedInputKey = JSON.stringify(inputs);
                preparedDataDir = prepared.absDir; preparedRouting = prepared.routing;
                const groups = observed ? parseGroups(observed, true, nextProfile.raw) : undefined;
                set(s => ({ profiles: s.profiles.map(x => x.id === id ? { ...x, ...nextProfile, updatedAt: Date.now() } : x),
                  audit: prepared.audit, stats: prepared.stats, configPath: absConfig, dataDir: prepared.absDir,
                  kernelError: null,
                  ...(groups ? { groups, proxyRuntime: {profileId: id, revision: s.runtimeConfigRevision, connectedAt: s.connectedAt, proxies: (observed as {proxies: Record<string, unknown>}).proxies}, routing: prepared.routing, routeRevision: s.routeRevision + 1 } : {}) }));
                if (groups) void pushTray(get());
                void persist(get());
                await api.finishConfig(receipt, false).catch(error => {
                  get().notify('error', `配置已应用，但事务副本清理失败：${errorText(error)}`);
                });
                return true;
              } catch (error) {
                await rollback();
                throw error;
              } finally {
                if (attemptedLoad) set({ runtimeConfigTransition: false });
              }
            }));
            configCommitChain = runCommit.catch(() => undefined);
            const result = await runCommit;
            if (result === 'retry') {
              await api.discardConfig(candidate!);
              candidate = undefined;
              continue;
            }
            if (!result) return false;
          }
          applied = true;
          break;
        }
        if (!applied) throw new Error('节点选择持续变化，本次未应用更新，请稍后重试');
        void persist(get());
        if (!quiet) get().notify('success', '订阅已更新');
        return true;
      } catch (e) {
        if (current()) {
          const reason = rollbackFailure ? `${rollbackFailure}（原始错误：${errorText(e)}）` : errorText(e);
          const message = `${stage}失败：${reason}；已保留原订阅内容${rollbackFailure ? '，运行状态未确认' : ''}`;
          set(s => ({ profileRefreshErrors: { ...s.profileRefreshErrors, [id]: message } }));
          if (!quiet) get().notify('error', message);
        }
        return false;
      } finally {
        unsubscribe();
        if (candidate) await api.discardConfig(candidate).catch(() => undefined);
        if (counted) configPending -= 1;
        set(s => ({ refreshingIds: s.refreshingIds.filter(x => x !== id), busy: configPending > 0 || s.importing }));
      }
    })().finally(() => { profileRefreshes.delete(id); });
    profileRefreshes.set(id, run);
    return run;
  },

  applyConfig: async () => {
    const request = ++configRequest;
    // 文件仍保留以供事务回滚，但任何重新准备都必须成功后才能恢复启动资格。
    preparedInputKey = '';
    const { activeId, profiles } = get();
    const profile = profiles.find((p) => p.id === activeId);
    if (!profile || !isTauri) return false;

    const inputKey = JSON.stringify(configInputsOf(get()));
    const inputs: ConfigInputs = JSON.parse(inputKey);
    const current = () => request === configRequest && JSON.stringify(configInputsOf(get())) === inputKey;
    configPending += 1;
    set({ busy: true });
    let candidate: string | undefined;
    try {
      const prepared = await prepareConfigCandidate(inputs, current);
      if (!prepared) return false;
      const { audit, stats, routing, absDir } = prepared;
      candidate = prepared.candidate;
      // 正式文件提交与启动读取共用串行队列，启动中不会被另一次提交替换内容。
      const run = configCommitChain.then(() => lifecycle.serial(async () => {
        if (!current()) return false;
        const receipt = candidate!;
        const absConfig = await api.commitConfig(receipt);
        candidate = undefined;
        const publish = () => {
          configRevision += 1;
          validatedRevision = configRevision;
          validatedPath = absConfig;
          preparedInputs = inputs;
          preparedInputKey = inputKey;
          preparedDataDir = absDir;
          preparedRouting = routing;
          set({ audit, stats, configPath: absConfig, dataDir: absDir });
        };
        if (!current()) {
          try { await api.finishConfig(receipt, true); }
          catch (error) {
            // 补偿失败或外部又提交过时不能断言磁盘版本，清除可启动缓存。
            validatedRevision = -1;
            validatedPath = '';
            preparedInputKey = '';
            preparedRouting = null;
            set({ configPath: '', audit: [], stats: null });
            get().notify('error', `配置回滚失败，需要重新生成后连接：${errorText(error)}`);
          }
          return false;
        }
        // 不可撤销的提交与内存发布同步收尾；后续请求等待本队列完成。
        publish();
        await api.finishConfig(receipt, false).catch(error => {
          get().notify('error', `配置已应用，但事务副本清理失败：${errorText(error)}`);
        });
        return current();
      }));
      configCommitChain = run.catch(() => undefined);
      return await run;
    } catch (e) {
      if (current()) get().notify('error', `生成或校验配置失败：${errorText(e)}`);
      return false;
    } finally {
      if (candidate) await api.discardConfig(candidate).catch(() => undefined);
      configPending -= 1;
      set({ busy: configPending > 0 || get().importing });
    }
  },

  startKernel: async (quiet = false) => {
    if (['starting', 'running'].includes(get().kernelPhase)) return;
    await startFor(lifecycle.begin(), quiet);
  },

  handleKernelLost: async () => {
    if (get().kernelPhase !== 'running') return;
    const token = lifecycle.begin();
    const current = () => lifecycle.current(token);
    const wantedCapture = get().sysProxyEnabled || get().tunEnabled;
    set({ kernelPhase: 'failed', connectedAt: null, kernelError: '内核已停止，详见 kernel.log', groups: [] });
    await lifecycle.serial(async () => {
      if (!current() || !get().sysProxyEnabled) return;
      await disableProxyOnFailure(get().settings.mixedPort);
      if (!current()) return;
      set({ sysProxyEnabled: false });
      void persist(get());
    });
    if (!current()) return;
    if (wantedCapture) {
      get().notify('info', '内核已退出，正在恢复…');
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await new Promise(r => setTimeout(r, 800 * attempt));
        if (!current()) return;
        const prepared = await get().applyConfig();
        if (!current()) return;
        if (prepared) await startFor(token, true, false);
        if (!current()) return;
        if (get().kernelPhase === 'running') {
          get().notify('success', '内核已自动恢复');
          break;
        }
        if (attempt === 3) get().notify('error', '内核恢复失败，详见 kernel.log');
      }
    } else get().notify('error', '内核已停止，系统代理已关闭。');
    if (current()) await pushTray(get());
  },

  restartKernel: async (quiet = true, expectedToken, prepared = false) =>
    restartKernelFor(expectedToken ?? lifecycle.begin(), quiet, prepared),

  stopKernel: async (quiet = false) => {
    await stopFor(lifecycle.begin(), quiet);
  },

  disconnect: async () => {
    const token = lifecycle.begin();
    await stopFor(token, false);
    if (!lifecycle.current(token) || get().kernelPhase !== 'stopped') return;
    if (get().tunEnabled || get().sysProxyEnabled) {
      set({ tunEnabled: false, sysProxyEnabled: false });
      await get().applyConfig();
      if (!lifecycle.current(token)) return;
      void persist(get());
      await pushTray(get());
    }
  },

  refreshGroups: async (quiet = true) => {
    if (!isTauri || get().runtimeConfigTransition) return false;
    const revision = getRoutingRevision();
    const session = get();
    const epoch = proxyReadEpoch;
    const current = () => epoch === proxyReadEpoch && !get().runtimeConfigTransition
      && proxySessionIdentity(get()) === proxySessionIdentity(session) && revision === getRoutingRevision();
    try {
      const raw = await api.mihomo('GET', '/proxies');
      if (!current()) return false;
      // 首次接管现有内核时从实际规则获取主路由；绝不在读取节点时重启/改配置。
      let routing = get().routing;
      if (!routing) {
        const rules = await api.mihomo('GET', '/rules') as { rules?: Array<{ type: string; proxy: string }> };
        if (!current()) return false;
        const parsed = parseGroups(raw, false);
        routing = routingPolicy(parsed.map(g => ({ name: g.name,
          type: ({ Selector: 'select', URLTest: 'url-test', Fallback: 'fallback' } as Record<string, string>)[g.type] ?? g.type,
          proxies: g.nodes.map(n => n.name) })),
          (rules?.rules ?? []).map(r => `${['Match', 'MATCH', 'Final'].includes(r.type) ? 'MATCH' : r.type},${r.proxy}`));
      }
      if (!current()) return false;
      const groups = parseGroups(raw);
      const orderChanged = JSON.stringify(get().groups.map(group => group.name)) !== JSON.stringify(groups.map(group => group.name));
      // 使用发布时的最新来源快照，避免并发节点读取覆盖刚完成的元数据。
      const previous = proxySnapshotMatches(get().proxyRuntime, session) ? get().proxyRuntime : null;
      set({ groups, routing, proxyRuntime: { profileId: session.activeId, revision: session.runtimeConfigRevision,
        connectedAt: session.connectedAt, sessionEpoch: epoch, proxies: (raw as {proxies?: Record<string, unknown>})?.proxies ?? {},
        providers: previous?.providers, providersError: previous?.providersError, providersChecked: previous?.providersChecked } });
      if (orderChanged) void pushTray(get());
      // 可选元数据独立完成；手选/固定的确认仅等待上述 /proxies 事实。
      void get().refreshProxyProviders();
      return true;
    } catch (e) {
      if (!quiet && current()) get().notify('error', `读取节点失败：${errorText(e)}`);
      return false;
    }
  },

  refreshProxyProviders: (force = false) => {
    const session = get();
    if (!isTauri || session.runtimeConfigTransition || session.kernelPhase !== 'running'
      || !proxySnapshotMatches(session.proxyRuntime, session)) return Promise.resolve(false);
    const epoch = proxyReadEpoch;
    const existing = proxyProviderReads.get(epoch);
    if (existing) return existing;
    if (!force && session.proxyRuntime?.providersChecked) return Promise.resolve(true);
    const config = readProxyConfiguration(session.profiles.find(profile=>profile.id===session.activeId)?.raw);
    const providerConfig = config['proxy-providers'];
    if (!force && (!providerConfig || typeof providerConfig !== 'object' || !Object.keys(providerConfig).length)) return Promise.resolve(false);
    const current = () => epoch === proxyReadEpoch && !get().runtimeConfigTransition
      && proxySessionIdentity(get()) === proxySessionIdentity(session) && proxySnapshotMatches(get().proxyRuntime, session);
    // 先标记预算，失败只由显式刷新重试；节点轮询不重复触发整份来源读取。
    set(state=>({proxyRuntime:state.proxyRuntime ? {...state.proxyRuntime,providersChecked:true} : null}));
    const request = (async () => {
      try {
        const providers = await api.mihomo('GET', '/providers/proxies');
        if (!current()) return false;
        set(state=>({proxyRuntime:state.proxyRuntime ? {...state.proxyRuntime,providers,providersError:undefined} : null}));
        return true;
      } catch (error) {
        if (!current()) return false;
        set(state=>({proxyRuntime:state.proxyRuntime ? {...state.proxyRuntime,providersError:errorText(error)} : null}));
        return false;
      } finally {
        proxyProviderReads.delete(epoch);
      }
    })();
    proxyProviderReads.set(epoch, request);
    return request;
  },

  selectNode: async (group, node, expectedRevision, beforeSelect): Promise<boolean> => {
    // 用户操作先使检测结果失效；串行 PUT 保证用户较晚的选择最后生效。
    const manual = expectedRevision === undefined;
    const request = manual ? ++manualSelectionRequest : manualSelectionRequest;
    if (manual) set(s => ({ routeRevision: s.routeRevision + 1 }));
    const revision = expectedRevision ?? getRoutingRevision();
    const token = lifecycle.token();
    const profileId = get().activeId;
    return lifecycle.serial(async () => {
      if (!lifecycle.current(token) || get().activeId !== profileId
          || (manual ? request !== manualSelectionRequest : revision !== getRoutingRevision())) return false;
      // 排队可能跨越休眠；自动探测必须在实际执行前再次取得切换许可。
      if (beforeSelect && !beforeSelect()) return false;
      set(s => ({ routeRevision: s.routeRevision + 1 }));
      return selectNodeFor(token, profileId, group, node, getRoutingRevision(), expectedRevision === undefined ? 'manual' : 'automatic');
    });
  },

  toggleFixedNode: async (group, node): Promise<boolean> => {
    const profileId = get().activeId;
    if (!profileId) return false;
    const request = ++manualSelectionRequest;
    set(s => ({ routeRevision: s.routeRevision + 1 }));
    if (get().fixedNodes[profileId]?.[group] === node) {
      saveFixedNode(profileId, group);
      return true;
    }
    const target = get().groups.find(g => g.name === group);
    if (get().kernelPhase !== 'running' || target?.type !== 'Selector') {
      get().notify('info', '固定使用需要已连接的手动选择组；自动测速、故障转移和负载均衡组暂不支持');
      return false;
    }
    const member = target.nodes.find(n => n.name === node);
    if (!member || isGroupNode(member, get().groups)) {
      get().notify('info', '展开对应分组后固定具体节点');
      return false;
    }
    const token = lifecycle.token();
    return lifecycle.serial(async () => {
      if (!lifecycle.current(token) || get().activeId !== profileId || request !== manualSelectionRequest) return false;
      const latest = get().groups.find(g => g.name === group);
      if (latest?.type !== 'Selector' || !latest.nodes.some(n => n.name === node && !isGroupNode(n, get().groups))) {
        get().notify('info', '节点配置已变化，请重新选择要固定的节点');
        return false;
      }
      set(s => ({ routeRevision: s.routeRevision + 1 }));
      return selectNodeFor(token, profileId, group, node, getRoutingRevision(), 'fixed');
    });
  },

  togglePinNode: (group, node) => {
    const current = get().pinnedNodes[group] ?? [];
    const next = current.includes(node)
      ? current.filter((x) => x !== node)
      : [...current, node];
    set({ pinnedNodes: { ...get().pinnedNodes, [group]: next } });
    void persist(get());
  },

  publishDelayBatch: (results) => {
    if (!results.length) return;
    const byNode = new Map<string, TargetLatencies>();
    for (const { node, target, delay } of results) {
      byNode.set(node, { ...byNode.get(node), [target]: delay });
    }
    const update = (group: ProxyGroup): ProxyGroup => ({ ...group, nodes: group.nodes.map(node => {
      const measured = byNode.get(node.name);
      if (!measured) return node;
      const target = groupLatencyTarget(group.name);
      return { ...node, delaysByTarget: { ...node.delaysByTarget, ...measured },
        delay: Object.prototype.hasOwnProperty.call(measured, target) ? measured[target] : node.delay };
    }) });
    if (globalGroup) globalGroup = update(globalGroup);
    set(s => ({ groups: s.groups.map(update) }));
  },

  testDelay: async (node, targetUrl = DEFAULT_LATENCY_URL, options = {}) => {
    const before = get();
    if (before.runtimeConfigTransition) return null;
    const current = () => {
      const state = get();
      return !state.runtimeConfigTransition && state.runtimeConfigRevision === before.runtimeConfigRevision
        && state.activeId === before.activeId && state.connectedAt === before.connectedAt && state.kernelPhase === before.kernelPhase && (options.isCurrent?.() ?? true);
    };
    const publish = (delay: number | null) => {
      if (!current()) return null;
      if (options.publish !== false) get().publishDelayBatch([{ node, target: targetUrl, delay }]);
      return delay;
    };
    try {
      const path = `/proxies/${encodeURIComponent(node)}`;
      const r: any = await api.mihomo(
        'GET',
        `${path}/delay?${latencyTestQuery(targetUrl)}`
      );
      if (!current()) return null;
      const delay = normalizeLatency(r?.delay);
      if (targetUrl !== GITHUB_LATENCY_URL || delay === null) return publish(delay);
      // expected=200 只更新目标 Alive；正数 delay 本身不代表 HTTP 状态匹配。
      const detail = await api.mihomo('GET', path) as { extra?: Record<string, { Alive?: boolean; alive?: boolean }> } | null;
      if (!current()) return null;
      const state = detail?.extra?.[targetUrl];
      return publish((state?.Alive ?? state?.alive) === true ? parseTargetLatencies(detail)[targetUrl] ?? null : null);
    } catch {
      return publish(null);
    }
  },

  toggleSystemProxy: async (on) => {
    if (!isTauri) {
      get().notify('error', '浏览器预览模式无法修改系统代理');
      return;
    }
    if (!on) {
      const token = lifecycle.begin();
      if (!get().tunEnabled) await stopFor(token, true);
      else await lifecycle.serial(async () => {
        if (!lifecycle.current(token)) return;
        const sp = await api.setSystemProxy(false, '127.0.0.1', get().settings.mixedPort);
        if (!lifecycle.current(token)) return;
        set({ sysProxyEnabled: sp.enabled });
        void persist(get());
      });
      return;
    }
    if (get().tunEnabled) {
      get().notify('info', 'TUN 已开启，先关闭 TUN 再开系统代理');
      return;
    }
    const token = lifecycle.begin();
    if (get().kernelPhase !== 'running') {
      await startFor(token, false);
      return;
    }
    await lifecycle.serial(async () => {
      if (!lifecycle.current(token)) return;
      try {
        const sp = await enableSystemProxy(get().settings.mixedPort);
        if (!lifecycle.current(token)) return;
        set({ sysProxyEnabled: sp.enabled });
        void persist(get());
        get().notify('info', '系统代理已开启');
      } catch (e) {
        if (lifecycle.current(token)) get().notify('error', `设置系统代理失败：${errorText(e)}`);
      }
      if (lifecycle.current(token)) await pushTray(get());
    });
  },

  setSysProxyEnabled: (on) => {
    if (on) rememberProxyPort(get().settings.mixedPort);
    set({ sysProxyEnabled: on });
    void persist(get());
    void pushTray(get());
  },

  syncAndroidVpn: async (active) => {
    const before = get();
    if (!isAndroid || before.kernelPhase !== 'running' || before.runtimeConfigTransition) return false;
    const token = lifecycle.token();
    const session = proxySessionIdentity(before);
    const status = await api.kernelStatus(before.settings.controllerSecret).catch(() => null);
    if (!active() || status?.running !== false || !lifecycle.current(token)
        || proxySessionIdentity(get()) !== session) return false;
    lifecycle.begin();
    set({ kernelPhase: 'stopped', connectedAt: null, groups: [], kernelError: null, tunEnabled: false });
    void persist(get());
    get().notify('info', 'VPN 已断开');
    return true;
  },

  setTun: async (on) => {
    if (!isTauri) {
      get().notify('error', '浏览器预览模式无法开启 TUN');
      return;
    }
    if (on && isWindows && !get().elevated) {
      set({ elevationPrompt: true });
      return;
    }
    const token = lifecycle.begin();
    const current = () => lifecycle.current(token);
    const wasRunning = get().kernelPhase === 'running';
    const previousCapture = { tunEnabled: get().tunEnabled, sysProxyEnabled: get().sysProxyEnabled };
    set({ tunEnabled: on });
    void persist(get());
    if (!on && !get().sysProxyEnabled) {
      await stopFor(token, true);
      if (!current()) return;
      if (get().kernelPhase !== 'stopped') {
        set({ tunEnabled: true });
        void persist(get());
        get().notify('error', 'TUN 关闭失败，内核仍在运行，请重试');
        return;
      }
      const prepared = await get().applyConfig();
      if (!current()) return;
      get().notify(prepared ? 'info' : 'error', prepared
        ? isAndroid ? 'VPN 已断开' : 'TUN 已关闭，内核已停止'
        : isAndroid ? 'VPN 已断开；配置生成失败，请修正后重新连接' : 'TUN 已关闭，内核已停止；配置生成失败，请修正后重新连接');
      await pushTray(get());
      return;
    }
    let prepared = false;
    try { prepared = await get().applyConfig(); }
    catch (error) { if (current()) get().notify('error', `配置生成失败：${errorText(error)}`); }
    if (!current()) return;
    if (!prepared) {
      set(previousCapture);
      await persist(get());
      if (current()) await pushTray(get());
      return;
    }
    if (wasRunning) {
      // 不调用公开重启入口，避免创建另一个代次。
      await stopFor(token, true);
      if (!current() || get().kernelPhase !== 'stopped') return;
    }
    if (on || wasRunning) await startFor(token, false);
    if (!current()) return;
    if (on && get().kernelPhase !== 'running') {
      set({ tunEnabled: false });
      await get().applyConfig();
      if (!current()) return;
    }
    void persist(get());
    await pushTray(get());
  },

  setPolicy: async (patch) => {
    const token = lifecycle.token();
    if (get().policyApplying || get().kernelPhase === 'starting' || get().kernelPhase === 'stopping') return false;
    set((s) => ({ policy: { ...s.policy, ...patch }, policyApplying: true, policyError: null }));
    void persist(get());
    try {
      if (!get().profiles.some(p => p.id === get().activeId)) {
        get().notify('info', '安全策略已保存，导入订阅并连接后生效');
        return true;
      }
      const applied = await get().applyConfig();
      if (!lifecycle.current(token)) return false;
      if (!applied) throw new Error('配置生成失败');
      const running = get().kernelPhase === 'running';
      if (running && !await get().restartKernel(true, token, true)) throw new Error('内核重启失败');
      get().notify('info', running ? '安全策略已生效' : '安全策略已保存，连接后生效');
      return true;
    } catch (error) {
      const message = `策略已保存但未生效：${errorText(error)}，请重试`;
      set({ policyError: message });
      get().notify('error', message);
      return false;
    } finally {
      set({ policyApplying: false });
    }
  },

  applyRuntimeSettings,

  changeOutboundMode: async (mode) => {
    const result = await applyRuntimeSettings({ mode }, {
      allowWithoutProfile: true, rollback: { config: true, restart: 'if-running' },
    });
    if (result.status !== 'failed') return;
    if (result.stage === 'config') get().notify('error', '配置生成失败，出站模式未切换');
    else if (result.stage === 'restart') get().notify('error', result.rolledBack
      ? '出站模式未能应用，继续使用原模式' : '模式已保存，但重新连接失败，请重试连接');
    else get().notify('error', `切换模式失败：${String(result.error)}`);
  },

  updateSettings: (patch) => {
    if (patch.mixedPort !== undefined && get().sysProxyEnabled) rememberProxyPort(get().settings.mixedPort);
    const next: AppSettings = { ...get().settings, ...patch };
    if (patch.textSize !== undefined) next.textSize = normalizeTextSize(patch.textSize);
    set({ settings: next });
    // 只保存待生效选项；下次连接生成，已运行的内核保持当前配置。
    if (patch.stableRouting !== undefined) set({ configPath: '' });

    // 主题即时生效
    if (patch.theme) useTheme.getState().setMode(patch.theme);
    if (patch.textSize !== undefined) setTextSize(next.textSize);

    // 跨启动的偏好同步到后端（失败不阻断 UI）
    if (patch.launchAtLogin !== undefined && isTauri) {
      void api
        .setLaunchLogin(patch.launchAtLogin)
        .catch((e) => console.error('[PPClash] 设置自启失败', e));
    }
    if (patch.closeToTray !== undefined && isTauri) {
      void api
        .setCloseToTray(patch.closeToTray)
        .catch((e) => console.error('[PPClash] 设置关窗行为失败', e));
    }
    if (
      patch.mode !== undefined ||
      patch.traySpeed !== undefined ||
      patch.hideDockOnClose !== undefined
    ) {
      void pushTray(get());
    }
    if (patch.controllerPort !== undefined) {
      setMihomoBase(patch.controllerPort);
    }
    if (patch.controllerSecret !== undefined) {
      setMihomoSecret(patch.controllerSecret);
    }
    if (patch.mixedPort !== undefined) {
      void pushTray(get());
      // 系统代理指向的端口变了，立即改过去，否则旧端口会失效
      if (get().sysProxyEnabled && isTauri) {
        const token = lifecycle.token();
        void lifecycle.serial(async () => {
          if (!lifecycle.current(token) || !get().sysProxyEnabled) return;
          await enableSystemProxy(next.mixedPort);
        }).catch((e) => console.error('[PPClash] 更新系统代理端口失败', e));
      }
    }

    void persist(get());
  },
}));

// 控制状态的每次变更都使旧检测失效，包括关开开关和快速 A→B→A。
useApp.subscribe((next, prev) => {
  if (proxySessionIdentity(next) !== proxySessionIdentity(prev)) proxyReadEpoch++;
  const identity = (s: AppStore) => JSON.stringify([s.activeId, s.connectedAt, s.kernelPhase,
    s.tunEnabled, s.sysProxyEnabled, s.settings.mode, s.settings.autoFailover,
    s.settings.controllerPort, s.settings.controllerSecret]);
  if (identity(next) !== identity(prev)) useApp.setState({ routeRevision: next.routeRevision + 1 });
});

// 开发期调试钩子：浏览器预览时可在控制台模拟「已连接」状态，方便调 UI
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__ppclash = { useApp, useTheme };
}
