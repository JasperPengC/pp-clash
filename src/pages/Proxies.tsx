import { PageHeader } from '../components/PageHeader';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Dialog } from '../components/Dialog';
import { NodeName } from '../components/NodeName';
import { SelectionIndicator } from '../components/SelectionIndicator';
import { EmptyState, ReadError, PageLink, Segmented, Spinner, Toggle } from '../components/ui';
import {
  IconAlert,
  IconImport,
  IconFlag,
  IconNodes,
  IconLocate,
  IconBolt,
  IconRefresh,
  IconSearch,
  IconX,
} from '../components/icons';
import { isGroupNode, useApp } from '../store/app';
import { usePageQuery, useProxyGroupPreference, useViewPreference } from '../store/view-preferences';
import { isAndroid } from '../core/platform';
import type { ProxyNode } from '../domain/app';
import { buildProxyDomain, proxyGroupKind, resolveProxyRoute, type ProxyRoute } from '../core/proxy-domain';
import { GITHUB_LATENCY_URL, groupLatencyTarget, latencyKey, readGroupLatency } from '../core/latency';
import { createLatencyBatchRunner, type LatencyBatchHandle, type LatencyBatchProgress } from '../core/latency-batch';

function delayBadge(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return 'node-delay';
  if (ms < 100) return 'node-delay ok';
  if (ms < 200) return 'node-delay fair';
  if (ms < 400) return 'node-delay slow';
  return 'node-delay bad';
}

const WINDOW_SIZE = 60;
// 页面卸载只取消批次；在途请求的槽位由模块调度器继续持有。
const batchRunner = createLatencyBatchRunner();

export function orderedGroupNodes<T extends { name: string; delay?: number | null }>(nodes: T[], _selectedName: string, sort: 'default' | 'delay' | 'name', availability: 'all' | 'available'): T[] {
  return nodes.filter(node => availability === 'all' || node.delay === undefined || (node.delay !== null && node.delay > 0)).sort((a, b) => {
    if (sort === 'default') return 0;
    if (sort === 'name') return a.name.localeCompare(b.name);
    const da = a.delay != null && a.delay > 0 ? a.delay : Infinity;
    const db = b.delay != null && b.delay > 0 ? b.delay : Infinity;
    return da === db ? 0 : da - db;
  });
}

/** 两列共用行高；已渲染行按实际高度校正，长名称和路径详情不裁切。 */
function VirtualNodeList({ nodes, group, focusName, renderNode }: { nodes: ProxyNode[]; group: string; focusName?: string; renderNode: (node: ProxyNode, index: number) => ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const [measurement, setMeasurement] = useState(0);
  const [columns, setColumns] = useState(2);
  const [scrollTop, setScrollTop] = useState(0);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const rowCount = Math.ceil(nodes.length / columns);
  const rowKeys = Array.from({ length: rowCount }, (_, row) => JSON.stringify(nodes.slice(row * columns, (row + 1) * columns).map(node => node.name)));
  const offsets = [0];
  for (const key of rowKeys) offsets.push(offsets.at(-1)! + (heights.current.get(key) ?? 78));
  const windowRows = Math.max(1, Math.floor(WINDOW_SIZE / columns));
  let first = 0;
  while (first + 1 < rowCount && offsets[first + 1] <= scrollTop) first++;
  const start = Math.max(0, Math.min(first - 3, rowCount - windowRows));
  const end = Math.min(rowCount, start + windowRows);

  useLayoutEffect(() => {
    if (!focusName) return;
    const index = nodes.findIndex(node => node.name === focusName);
    if (index < 0) return;
    const top = offsets[Math.floor(index / columns)];
    viewport.current!.scrollTop = top;
    setScrollTop(top);
    setFocusIndex(index);
  }, [focusName, columns]);

  useLayoutEffect(() => {
    const element = viewport.current!;
    const resize = () => { if (element.clientWidth) setColumns(Math.max(1, Math.floor((element.clientWidth + 8) / 368))); };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const measure = () => {
      let changed = false;
      for (const row of viewport.current!.querySelectorAll<HTMLElement>('.proxy-virtual-row')) {
        const height = row.getBoundingClientRect().height;
        const key = row.dataset.rowKey!;
        if (height > 0 && heights.current.get(key) !== height) { heights.current.set(key, height); changed = true; }
      }
      if (changed) setMeasurement(value => value + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    viewport.current!.querySelectorAll('.proxy-virtual-row').forEach(row => observer.observe(row));
    return () => observer.disconnect();
  }, [start, end, columns, nodes, measurement]);

  useLayoutEffect(() => {
    if (focusIndex === null) return;
    const control = viewport.current!.querySelector<HTMLButtonElement>(`[data-node-index="${focusIndex}"] .proxy-node-select`);
    (control?.disabled ? viewport.current : control)?.focus();
    setFocusIndex(null);
  }, [start, end, focusIndex]);

  return <div ref={viewport} className="proxy-node-viewport" id={`proxy-group-${encodeURIComponent(group)}`} role="list"
    aria-label={`${group} 节点`} tabIndex={0} style={{ '--proxy-columns': columns } as CSSProperties}
    onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
    onKeyDown={event => {
      if (event.target !== event.currentTarget && !(event.target as HTMLElement).classList.contains('proxy-node-select')) return;
      const index = Number((event.target as HTMLElement).closest<HTMLElement>('[data-node-index]')?.dataset.nodeIndex ?? start * columns);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? nodes.length - 1
        : event.key === 'ArrowDown' ? index + columns : event.key === 'ArrowUp' ? index - columns
        : event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : null;
      if (next === null || !nodes.length) return;
      event.preventDefault();
      const target = Math.max(0, Math.min(next, nodes.length - 1));
      const top = offsets[Math.floor(target / columns)];
      viewport.current!.scrollTop = top;
      setScrollTop(top);
      setFocusIndex(target);
    }}>
    <div className="proxy-virtual-spacer" style={{ height: offsets[start] }} aria-hidden="true" />
    <div className="proxy-node-grid">
      {rowKeys.slice(start, end).map((key, offset) => <div className="proxy-virtual-row" data-row-key={key} key={key}>
        {nodes.slice((start + offset) * columns, (start + offset + 1) * columns).map((node, index) => renderNode(node, (start + offset) * columns + index))}
      </div>)}
    </div>
    <div className="proxy-virtual-spacer" style={{ height: offsets[rowCount] - offsets[end] }} aria-hidden="true" />
  </div>;
}

function RouteDetails({ route }: { route: ProxyRoute }) {
  return <div className="proxy-route-details">
    <div className="proxy-route-line"><span>选择关系</span><span>{route.selection.join(' → ') || '尚未确认'}</span></div>
    {route.kind === 'multiple' && <p>多出口 · 由内核按连接分配，不能确认唯一出口</p>}
    {route.forwarding.length > 0 && <div className="proxy-route-line"><span>{route.kind === 'relay' ? '原 Relay 顺序' : '转发顺序'}{route.certainty === 'configuration' ? ' · 配置推断' : ''}</span><span>{route.forwarding.join(' → ')}</span></div>}
    {route.issues.map(issue => <p className="proxy-route-note" key={`${issue.code}:${issue.at}`}>{issue.message}</p>)}
  </div>;
}

export function ProxiesPage({ active = true }: { active?: boolean } = {}) {
  const groups = useApp((s) => s.groups);
  const proxyRuntime = useApp((s) => s.proxyRuntime);
  const kernelPhase = useApp((s) => s.kernelPhase);
  const connectedAt = useApp((s) => s.connectedAt);
  const runtimeConfigRevision = useApp((s) => s.runtimeConfigRevision);
  const runtimeConfigTransition = useApp((s) => s.runtimeConfigTransition);
  const profiles = useApp((s) => s.profiles);
  const activeId = useApp((s) => s.activeId);
  const selectNode = useApp((s) => s.selectNode);
  const fixedNodes = useApp((s) => s.fixedNodes);
  const toggleFixedNode = useApp((s) => s.toggleFixedNode);
  const testDelay = useApp((s) => s.testDelay);
  const publishDelayBatch = useApp((s) => s.publishDelayBatch);
  const refreshGroups = useApp((s) => s.refreshGroups);
  const notify = useApp((s) => s.notify);

  const [pendingNode, setPendingNode] = useState<string | null>(null);
  const nodeLock = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshLock = useRef(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refresh = async () => {
    if (refreshLock.current) return;
    refreshLock.current = true; setRefreshing(true);
    try {
      const ok = await refreshGroups(false);
      if (ok) void useApp.getState().refreshProxyProviders(true);
      setRefreshError(ok ? null : '无法读取节点，显示上次数据，请重试');
    } catch (e) { setRefreshError(String(e)); }
    finally { refreshLock.current = false; setRefreshing(false); }
  };
  const choose = async (group: string, name: string, fixed = false) => {
    if (nodeLock.current) return;
    nodeLock.current = true; setPendingNode(`${group}|${name}`);
    try { await (fixed ? toggleFixedNode(group, name) : selectNode(group, name)); }
    catch (e) { notify('error', `切换节点失败：${String(e)}`); }
    finally { nodeLock.current = false; setPendingNode(null); }
  };

  const [query, setQuery] = usePageQuery(JSON.stringify(['proxies', activeId]));
  const [sortBy, setSortBy] = useViewPreference('proxySort');
  const [hideUnavailable, setHideUnavailable] = useViewPreference('proxyAvailableOnly');
  const [selectedGroup, setSelectedGroup] = useProxyGroupPreference(activeId);
  const [allGroupsOpen, setAllGroupsOpen] = useState(false);
  const [groupQuery, setGroupQuery] = useState('');
  const [inspectedNode, setInspectedNode] = useState<{ scope: string; name: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [delays, setDelays] = useState<Record<string, number | null>>({});
  const [testingNodes, setTestingNodes] = useState<Set<string>>(new Set());
  const testingLock = useRef(false);
  const testEpoch = useRef(0);
  const batch = useRef<LatencyBatchHandle | null>(null);
  const visible = useRef(active);
  visible.current = active;
  const [progress, setProgress] = useState<LatencyBatchProgress | null>(null);
  const [windowReset, setWindowReset] = useState(0);
  const [focusGroup, setFocusGroup] = useState<string | null>(null);

  const connected = kernelPhase === 'running';
  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeId),
    [profiles, activeId]
  );

  const snapshot = proxyRuntime?.profileId === activeId && proxyRuntime?.revision === runtimeConfigRevision
    && proxyRuntime?.connectedAt === connectedAt ? proxyRuntime : null;
  const runtimeMatches = connected && (!proxyRuntime || !!snapshot);
  const domain = useMemo(() => buildProxyDomain({ raw: activeProfile?.raw, groups: runtimeMatches ? groups : [],
    profileId: activeId, revision: runtimeConfigRevision, runtime: runtimeMatches,
    runtimeProxies: snapshot?.proxies, providers: snapshot?.providers, providersError: snapshot?.providersError }),
    [activeProfile?.raw, groups, activeId, runtimeConfigRevision, runtimeMatches, snapshot]);
  const usingPreview = !runtimeMatches || (groups.length === 0 && !snapshot);
  const displayGroups = domain.groups;
  const waitingForSources = displayGroups.some(group=>group.providers.some(provider=>['waiting','error'].includes(provider.state)));

  useEffect(() => {
    testEpoch.current += 1;
    testingLock.current = false;
    setDelays({});
    setTesting(false);
    setTestingNodes(new Set());
    setProgress(null);
    setWindowReset(value => value + 1);
    setAllGroupsOpen(false);
    return () => { testEpoch.current += 1; batch.current?.cancel(true); };
  }, [activeId, connectedAt, connected, runtimeConfigRevision, runtimeConfigTransition]);

  useEffect(() => {
    if (active) return;
    testEpoch.current++;
    batch.current?.cancel(true);
    testingLock.current = false;
    setTesting(false);
    setTestingNodes(new Set());
    setProgress(previous => previous?.status === 'running' ? { ...previous, status: 'cancelled' } : previous);
  }, [active]);

  useEffect(() => {
    if (!focusGroup) return;
    const current = document.getElementById(`proxy-group-${encodeURIComponent(focusGroup)}`)?.querySelector<HTMLElement>('.proxy-node.selected .proxy-node-select');
    current?.focus();
    current?.scrollIntoView?.({ block: 'nearest' });
    setFocusGroup(null);
  }, [focusGroup, windowReset, query, hideUnavailable]);

  const changeQuery = (value: string) => {
    setQuery(value);
    setInspectedNode(null);
  };

  const nodeLatency = (group: string, node: ProxyNode) => readGroupLatency(delays, group, node.name, node.delaysByTarget);
  const visibleNodes = (groupName: string, nodes: typeof displayGroups[number]['nodes'], search = query, onlyAvailable = hideUnavailable) => {
    const q = search.trim().toLowerCase();
    const group = displayGroups.find(item => item.name === groupName);
    const selected = !usingPreview && group?.type !== 'LoadBalance' && group?.type !== 'Relay' ? group?.now ?? '' : '';
    return orderedGroupNodes(nodes.filter(node => !q || node.name.toLowerCase().includes(q)).map(node => ({ ...node, delay: nodeLatency(groupName, node) })),
      selected, sortBy, onlyAvailable ? 'available' : 'all').map(node => ({ ...node, delay: node.delay ?? null }));
  };

  const runTest = (targets: Array<{ group: string; node: string }>) => {
    if (testingLock.current || !connected || !active || runtimeConfigTransition || targets.length === 0) return;
    testingLock.current = true;
    const epoch = ++testEpoch.current;
    const session = useApp.getState();
    const isCurrent = () => {
      const state = useApp.getState();
      return epoch === testEpoch.current && visible.current && state.activeId === session.activeId &&
        state.connectedAt === session.connectedAt && state.kernelPhase === 'running'
        && !state.runtimeConfigTransition && state.runtimeConfigRevision === session.runtimeConfigRevision;
    };
    const items = targets.map(item => ({ ...item, target: groupLatencyTarget(item.group) }));
    setTesting(true);
    setTestingNodes(new Set(items.map(item => latencyKey(item.group, item.target, item.node))));
    batch.current = batchRunner.start(items, {
      requestScope: JSON.stringify([session.activeId, session.connectedAt, session.runtimeConfigRevision]),
      isCurrent,
      measure: item => testDelay(item.node, item.target, { publish: false, isCurrent }),
      onUpdate: update => {
        if (!isCurrent()) return;
        if (update.results.length) {
          publishDelayBatch(update.results);
          setDelays(previous => {
            const next = { ...previous };
            for (const result of update.results) next[latencyKey(result.group, result.target, result.node)] = result.delay;
            return next;
          });
          setTestingNodes(previous => {
            const next = new Set(previous);
            for (const result of update.results) next.delete(latencyKey(result.group, result.target, result.node));
            return next;
          });
        }
        setProgress(update.progress);
        if (update.progress.status !== 'running') {
          testingLock.current = false;
          setTesting(false);
          setTestingNodes(new Set());
          if (update.progress.status === 'completed') notify('success', `测速完成 · ${update.progress.completed} / ${update.progress.total}`);
          else if (update.progress.status === 'cancelled') notify('info', `测速已取消 · ${update.progress.completed} / ${update.progress.total}`);
        }
      },
    });
  };

  const testGroup = (groupName: string, nodes: typeof displayGroups[number]['nodes']) =>
    runTest(visibleNodes(groupName, nodes).map(node => ({ group: groupName, node: node.name })));

  const locateCurrent = (group: typeof displayGroups[number]) => {
    if (!group.nodes.some(node => node.name === group.now)) return;
    changeQuery('');
    setHideUnavailable(false);
    setSelectedGroup(group.name);
    setWindowReset(value => value + 1);
    setFocusGroup(group.name);
  };

  const currentGroupName = displayGroups.some(group => group.name === selectedGroup)
    ? selectedGroup : displayGroups[0]?.name;
  const filteredGroups = displayGroups.filter(group => group.name === currentGroupName).map(g => ({ g, nodes: visibleNodes(g.name, g.nodes) }));
  const groupRail = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const rail = groupRail.current;
    const selected = rail?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!rail || !selected) return;
    const bounds = rail.getBoundingClientRect();
    const item = selected.getBoundingClientRect();
    if (item.left < bounds.left) rail.scrollLeft += item.left - bounds.left;
    else if (item.right > bounds.right) rail.scrollLeft += item.right - bounds.right;
  }, [currentGroupName, domain.identity]);
  useEffect(() => {
    const rail = groupRail.current;
    if (!rail) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.shiftKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY) || rail.scrollWidth <= rail.clientWidth) return;
      const before = rail.scrollLeft;
      rail.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rail.clientWidth : 1);
      if (rail.scrollLeft !== before) event.preventDefault();
    };
    rail.addEventListener('wheel', onWheel, { passive: false });
    return () => rail.removeEventListener('wheel', onWheel);
  }, [displayGroups.length]);
  const inspectGroup = (name: string) => {
    setSelectedGroup(name);
    setInspectedNode(null);
    changeQuery('');
    setAllGroupsOpen(false);
  };
  const groupMatches = displayGroups.filter(group => {
    const q = groupQuery.trim().toLowerCase();
    return !q || group.name.toLowerCase().includes(q) || group.nodes.some(node => node.name.toLowerCase().includes(q));
  });

  const subTitle = (() => {
    if (profiles.length === 0) return '导入订阅后显示节点';
    if (runtimeConfigTransition) return '配置切换中 · 显示上次结果';
    if (usingPreview)
      return `${displayGroups.length} 个分组 · 订阅预览`;
    if (!connected) return '未接管';
    if (!displayGroups.length) return '暂无分组';
    return `${displayGroups.length} 个分组`;
  })();

  const emptyView = (() => {
    if (profiles.length === 0) {
      return {
        icon: <IconImport size={19} />,
        title: '尚未导入订阅',
        desc: '支持订阅链接和本地配置文件',
        action: (
          <PageLink page="profiles" label="导入订阅" icon={<IconImport size={16} />} />
        ),
      };
    }
    if (!connected) {
      return {
        icon: <IconNodes size={19} />,
        title: '内核未运行',
        desc: '未接管流量。',
        action: (
          <PageLink page="overview" label="去概览开启" />
        ),
      };
    }
    return {
      icon: <IconAlert size={19} />,
      title: '没有读到节点',
      desc: '内核没有返回节点分组。',
      action: (
        <button type="button" className="btn" onClick={() => void refresh()}>
          刷新
        </button>
      ),
    };
  })();

  const showFilterSummary = query.trim() || hideUnavailable || usingPreview || waitingForSources;
  const browserChrome = (actions?: ReactNode) => <div className="proxy-browser-chrome">
          <div className="proxy-toolbar" aria-label="节点工具条">
          <div className="node-search">
            <IconSearch size={12} />
            <input
              value={query}
              onChange={(e) => changeQuery(e.target.value)}
              placeholder="搜索节点"
              aria-label="搜索节点"
              spellCheck={false}
            />
            {query && (
              <button
                type="button"
                className="node-search-clear"
                aria-label="清空搜索"
                onClick={() => changeQuery('')}
              >
                <IconX size={11} />
              </button>
            )}
          </div>
          <div className="proxy-available">
            <span>仅显示可用</span>
            <Toggle
              on={hideUnavailable}
              onChange={value => { setHideUnavailable(value); setInspectedNode(null); }}
              label="仅显示可用节点"
            />
          </div>
          <Segmented ariaLabel="排序方式" value={sortBy} onChange={value => { setSortBy(value); setInspectedNode(null); }}
            options={[{ value: 'default', label: '默认' }, { value: 'delay', label: '延迟' }, { value: 'name', label: '名称' }]} />
          {actions}
          </div>
          {showFilterSummary && <div className="proxy-filter-summary" role="status">
            {(query.trim() || hideUnavailable) && <span>{filteredGroups.find(item => item.g.name === currentGroupName)?.nodes.length ?? 0} 个匹配节点</span>}
            {waitingForSources && filteredGroups.every(item=>item.nodes.length===0) && <span>节点源待加载</span>}
            {usingPreview && <span>订阅预览 · 连接后可切换和测速</span>}
          </div>}
          </div>;

  return (
    <>
      {active && testing && progress?.status === 'running' && <div className="proxy-measure-toast" role="status" aria-live="polite">
        <Spinner small /><span>正在测速 <b>{progress.completed} / {progress.total}</b></span>
        <button type="button" className="btn btn-ghost btn-sm" aria-label="取消测速" onClick={() => batch.current?.cancel()}>取消</button>
      </div>}
      <PageHeader title="策略节点" mobileTitle="节点" subtitle={subTitle}>
          <button
            type="button"
            className="icon-btn"
            title="刷新节点"
            aria-label="刷新节点"
            disabled={!connected || refreshing}
            onClick={() => void refresh()}
          >
            <IconRefresh size={15} />
          </button>

      </PageHeader>

      <div className="page-scroll proxy-page">
        <div className="page-inner">
          <section className={displayGroups.length > 0 ? 'proxy-browser' : 'proxy-browser-empty'} aria-label="节点浏览">
          {displayGroups.length > 0 && <>
                <div className="proxy-group-pane">
                  <div className="proxy-group-rail seg">
                    <nav ref={groupRail} className="proxy-group-sidebar selection-track" aria-label="策略分组"
                      onKeyDown={event => {
                        const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
                        if (!keys.includes(event.key)) return;
                        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
                        const index = buttons.indexOf(event.target as HTMLButtonElement);
                        if (index < 0) return;
                        event.preventDefault();
                        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
                          : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)));
                        buttons[next]?.click(); buttons[next]?.focus({ preventScroll: true });
                      }}>
                      <SelectionIndicator value={currentGroupName} />
                      {displayGroups.map(g => <button type="button" key={g.name}
                        className={`proxy-group-nav seg-btn${g.name === currentGroupName ? ' active' : ''}`}
                        tabIndex={g.name === currentGroupName ? 0 : -1}
                        aria-label={`查看分组 ${g.name}`} aria-current={g.name === currentGroupName ? 'true' : undefined}
                        title={`${g.name} · ${proxyGroupKind(g.type)} · ${g.nodes.length} 个成员`} onClick={() => inspectGroup(g.name)}>
                        <span className="proxy-group-nav-name">{g.name}</span>
                        <span className="proxy-group-nav-meta">{g.nodes.length}</span>
                      </button>)}
                    </nav>
                  </div>
                  <button type="button" className="btn proxy-all-groups" aria-label={`全部分组 ${displayGroups.length}`}
                    aria-haspopup="dialog" aria-expanded={allGroupsOpen} onClick={() => { setGroupQuery(''); setAllGroupsOpen(true); }}>
                    全部分组 <span>{displayGroups.length}</span>
                  </button>
                </div>
          </>}
          {filteredGroups.every(item => item.g.name !== currentGroupName) && browserChrome()}
          {runtimeConfigTransition && <p className="proxy-scope-note" role="status">配置正在切换，当前运行链路尚未确认；切换完成后恢复选择和测速。</p>}
          {refreshError && <ReadError message={refreshError} busy={refreshing} onRetry={() => void refresh()} />}
          {displayGroups.length === 0 ? (
            <section className="card">
              <EmptyState {...emptyView} />
            </section>
          ) : (
            <>
              {filteredGroups.length === 0 && <div className="proxy-empty">
                <span>没有匹配的节点</span>
                <button type="button" className="btn btn-sm" onClick={() => changeQuery('')}>清空搜索</button>
              </div>}
              <div className="proxy-workspace">
              <div className="proxy-groups">
                {filteredGroups.filter(item => item.g.name === currentGroupName).map(({ g, nodes }) => {
                  const target = groupLatencyTarget(g.name);
                  const groupTesting = nodes.some((n) => testingNodes.has(latencyKey(g.name, target, n.name)));
                  const current = g.type === 'LoadBalance' || g.type === 'Relay' ? '' : g.now;
                  const route = resolveProxyRoute(domain, g.name);
                  const canSelect = connected && !usingPreview && !runtimeConfigTransition && !g.synthetic && g.type === 'Selector';
                  const chainSelected = !!domain.objects.get(route.terminal ?? '')?.dialerProxy;
                  return (
                    <section key={g.name} className="proxy-group expanded" aria-label={g.name}>
                      <div className="proxy-group-head">
                        {browserChrome(<div className="proxy-group-actions">
                          <button
                            type="button"
                            className="btn-icon proxy-group-action"
                            aria-label={`${g.name} 测速`}
                            title={target === GITHUB_LATENCY_URL ? '测试 GitHub 目标延迟' : '测试分组延迟'}
                            disabled={!active || !connected || usingPreview || runtimeConfigTransition || testing || nodes.length === 0}
                            onClick={(e) => {
                              e.stopPropagation();
                              testGroup(g.name, g.nodes);
                            }}
                          >
                            {groupTesting ? <Spinner small /> : <IconBolt size={17} />}
                          </button>
                          <button type="button" className="btn-icon proxy-group-action"
                            aria-label={`${g.name} 定位当前节点`}
                            title="定位当前节点"
                            disabled={usingPreview || !current || !g.nodes.some(node => node.name === current)}
                            onClick={event => { event.stopPropagation(); locateCurrent(g); }}>
                            <IconLocate size={16} />
                          </button>
                        </div>)}
                      </div>

                      {g.type === 'LoadBalance' && <p className="proxy-scope-note">多出口 · 按连接自动分配</p>}
                      {g.type === 'Relay' && <p className="proxy-scope-note">按配置顺序转发 · 实际链路未确认</p>}
                      {g.providers.length > 0 && <div className="proxy-provider-status" aria-label="节点来源">
                        <span>订阅中的节点源 · 成员来源以运行快照为准</span>
                        {g.providers.map(provider => <div key={provider.name}>
                          <strong>{provider.name}</strong>
                          <span>{({waiting:'等待节点源',loaded:`已加载 ${provider.count} 个节点`,empty:'已加载 · 暂无节点',cached:'源读取失败 · 显示上次结果',error:'源读取失败'} as const)[provider.state]}</span>
                          {provider.updatedAt && <time dateTime={provider.updatedAt} title={provider.updatedAt}>更新于 {Number.isNaN(Date.parse(provider.updatedAt)) ? provider.updatedAt : new Date(provider.updatedAt).toLocaleString()}</time>}
                          {provider.error && <span>{provider.error}</span>}
                        </div>)}
                      </div>}
                      {g.membershipUncertain && <p className="proxy-scope-note">预览未执行内核的动态筛选条件，实际成员以内核为准。</p>}
                      {chainSelected && <p className="proxy-scope-note">固定仅作用于此组中的落地节点；前置策略仍可变化，实际转发链路未确认。</p>}
                        {nodes.length === 0 && <div className="proxy-empty">{g.providers.some(provider => provider.state === 'waiting') ? '等待节点源加载后显示成员' : '没有符合筛选条件的节点'}</div>}
                        <VirtualNodeList key={JSON.stringify([domain.identity, g.name, query, sortBy, hideUnavailable, windowReset])}
                          nodes={nodes} group={g.name} focusName={focusGroup === g.name ? current : undefined} renderNode={(node, index) => {
                            const key = latencyKey(g.name, target, node.name);
                            const ms = nodeLatency(g.name, node);
                            const selected = !usingPreview && current === node.name;
                            const fixed = fixedNodes[activeId ?? '']?.[g.name] === node.name;
                            const nestedGroup = isGroupNode(node, displayGroups);
                            const fixedDisabled = pendingNode !== null || runtimeConfigTransition || (!fixed && (!canSelect || nestedGroup));
                            const object = domain.objects.get(node.name);
                            const inspected = inspectedNode?.scope === domain.identity && inspectedNode.name === node.name;
                            const fixedTitle = fixed ? '取消固定（保持当前出口）'
                              : !connected || usingPreview ? '连接后才能固定使用节点'
                              : nestedGroup ? '展开对应分组后固定具体节点'
                              : g.type !== 'Selector' ? '此组由内核自动测速、故障转移或负载均衡，暂不支持固定使用'
                              : object?.dialerProxy ? '仅固定此组的落地节点；前置策略仍可变化，不能保证整条链路固定'
                              : '固定此组的节点选择；实际转发链路未确认，故障时按保守规则切换';
                            const busy = testingNodes.has(key);
                            return (
                              <div
                                key={node.name}
                                role="listitem"
                                aria-posinset={index + 1}
                                aria-setsize={nodes.length}
                                data-node-index={index}
                                className={`proxy-node${selected ? ' selected' : ''}`}
                                onClick={() => { if (canSelect && !nodeLock.current) void choose(g.name, node.name); }}
                              >
                                <button type="button" className={`proxy-node-select${selected ? ' selected' : ''}`}
                                  aria-pressed={selected} disabled={!canSelect || pendingNode !== null} title={node.name}>
                                <span className="proxy-node-indicator" aria-hidden="true">
                                  {pendingNode === `${g.name}|${node.name}` ? <Spinner small /> : <span />}
                                </span>
                                <span className="proxy-node-name">
                                  <span className="proxy-node-title"><NodeName name={node.name} />
                                    {(selected || fixed) && <span className="node-states">
                                      {selected && <span className="node-state current">当前</span>}
                                      {fixed && <span className="node-state fixed">固定</span>}
                                    </span>}
                                  </span>
                                  <span className="proxy-node-meta">{nestedGroup ? `策略 · ${proxyGroupKind(node.type)}` : node.type || '未知引用'}{object?.providers.length ? ` · ${object.providers.join(' / ')}` : ''}{object?.dialerProxy ? ' · 含前置' : ''}{!canSelect ? ' · 只读' : ''}</span>
                                </span>
                                </button>
                                {!isAndroid && <button
                                    type="button"
                                    className={`node-pin${fixed ? ' pinned' : ''}`}
                                    aria-label={fixed ? `取消固定 ${node.name}` : `固定使用 ${node.name}`}
                                    aria-pressed={fixed}
                                    disabled={fixedDisabled}
                                    title={fixedTitle}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void choose(g.name, node.name, true);
                                    }}
                                  >
                                    <IconFlag
                                      size={11}
                                      filled={fixed}
                                    />
                                  </button>}
                                <button type="button" className="proxy-node-details-btn" aria-label={`查看路径 ${node.name}`}
                                  aria-expanded={inspected} onClick={event => {event.stopPropagation(); setInspectedNode(inspected ? null : {scope:domain.identity,name:node.name});}} title="查看节点路径"><IconNodes size={13} /></button>
                                {busy ? (
                                  <span className="node-delay">
                                    <Spinner small />
                                  </span>
                                ) : (
                                  <span className={delayBadge(ms)} title={target === GITHUB_LATENCY_URL ? 'GitHub 目标延迟' : '节点延迟'}>
                                    {ms === undefined ? '未测' : ms === null ? '失败' : `${ms} ms`}
                                  </span>
                                )}
                                {inspected && <div className="proxy-node-detail" onClick={event=>event.stopPropagation()}>
                                  <RouteDetails route={resolveProxyRoute(domain,node.name)} />
                                  {nestedGroup && <button type="button" className="btn btn-sm" onClick={() => inspectGroup(node.name)}>查看此策略成员</button>}
                                  {isAndroid && !nestedGroup && <button type="button" className="btn btn-sm"
                                    disabled={fixedDisabled} aria-pressed={fixed} title={fixedTitle}
                                    onClick={() => void choose(g.name, node.name, true)}>
                                    <IconFlag size={16} filled={fixed} />{fixed ? '取消固定' : '固定使用此节点'}
                                  </button>}
                                  <p>固定范围：{nestedGroup ? '先进入对应分组，再固定具体节点。' : '仅固定此组中的节点选择；前置策略仍可变化，实际链路未确认。'}</p>
                                </div>}
                              </div>
                            );
                          }} />
                    </section>
                  );
                })}
              </div>
              </div>

            </>
          )}
          </section>
          <Dialog open={allGroupsOpen} labelledBy="proxy-group-picker-title" onDismiss={() => setAllGroupsOpen(false)}>
            <div className="proxy-group-picker-head">
              <h2 id="proxy-group-picker-title">全部分组 <span>{displayGroups.length}</span></h2>
              <button type="button" className="icon-btn" aria-label="关闭全部分组" onClick={() => setAllGroupsOpen(false)}><IconX size={14} /></button>
            </div>
            <label className="proxy-group-picker-search"><IconSearch size={14} /><input aria-label="搜索全部分组"
              placeholder="搜索分组或成员名称" value={groupQuery} onChange={event => setGroupQuery(event.target.value)} spellCheck={false} /></label>
            <div className="proxy-group-options" aria-label="全部策略分组">
              {groupMatches.map(g => <button type="button" key={g.name} className={`proxy-group-option${g.name === currentGroupName ? ' active' : ''}`}
                aria-current={g.name === currentGroupName ? 'true' : undefined} onClick={() => inspectGroup(g.name)}>
                <span className="proxy-group-option-title"><strong>{g.name}</strong><span>{g.name === currentGroupName ? '当前分组 · ' : ''}{proxyGroupKind(g.type)} · {g.nodes.length} 个成员</span></span>
                <span className="proxy-group-option-current">{g.synthetic ? '浏览全部节点' : g.type === 'LoadBalance' ? '多出口' : g.type === 'Relay' ? '原顺序 · 未验证' : g.now || (g.providers.some(provider => provider.state === 'waiting') ? '等待节点源' : '尚未确认')}</span>
              </button>)}
              {!groupMatches.length && <p className="proxy-group-picker-empty">没有匹配的分组或成员</p>}
            </div>
          </Dialog>
        </div>
      </div>
    </>
  );
}
