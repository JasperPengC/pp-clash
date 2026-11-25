import { PageHeader } from '../components/PageHeader';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { usePageQuery, useViewPreference } from '../store/view-preferences';
import { EmptyState, PageLink, ReadError, Segmented, Spinner } from '../components/ui';
import {
  IconActivity,
  IconChevronDown,
  IconChevronRight,
  IconRefresh,
  IconSearch,
  IconX,
} from '../components/icons';
import { useApp } from '../store/app';
import { api } from '../core/api';
import { formatBytes } from '../core/format';
import { startPolling } from '../core/polling';
import { VirtualList } from '../components/VirtualList';
import { isAndroid } from '../core/platform';

interface RawConn {
  id: string;
  upload: number;
  download: number;
  start: string;
  chains?: string[];
  rule?: string;
  rulePayload?: string;
  metadata?: {
    network?: string;
    host?: string;
    destinationIP?: string;
    destinationPort?: string | number;
    sourceIP?: string;
    process?: string;
  };
}

function hostOf(c: RawConn): string {
  const m = c.metadata ?? {};
  const host = m.host || m.destinationIP || m.sourceIP || '未知';
  const port = m.destinationPort ? `:${m.destinationPort}` : '';
  return `${host}${port}`;
}

export function ConnectionsPage({ active = true }: { active?: boolean }) {
  const kernelPhase = useApp((s) => s.kernelPhase);
  const notify = useApp((s) => s.notify);
  const textSize = useApp(s => s.settings.textSize);
  // Android 的页面根节点由 main.tsx 标记；测试与桌面预览不应仅因 user-agent 被误判为移动布局。
  const androidLayout = isAndroid && typeof document !== 'undefined' && document.documentElement.classList.contains('android-window');
  const rowHeight = androidLayout
    ? textSize === 'large' ? 72 : textSize === 'larger' ? 68 : 64
    : textSize === 'large' ? 56 : textSize === 'larger' ? 54 : 52;
  const connected = kernelPhase === 'running';

  const [conns, setConns] = useState<RawConn[]>([]);
  const [totals, setTotals] = useState({ up: 0, down: 0 });
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const inFlight = useRef(false);
  const readEpoch = useRef(0);
  const operation = useRef(false);
  const available = useRef(active && connected);
  available.current = active && connected;
  const [closing, setClosing] = useState<string | null>(null);
  const [query, setQuery] = usePageQuery('connections');
  const deferredQuery = useDeferredValue(query);
  const [sortBy, setSortBy] = useViewPreference('connectionSort');
  const [closingAll, setClosingAll] = useState(false);
  const [confirmCloseAll, setConfirmCloseAll] = useState(false);
  const [view, setView] = useViewPreference('connectionView');
  const [expandedProcess, setExpandedProcess] = useState<string | null>(null);
  const [closingProcess, setClosingProcess] = useState<string | null>(null);
  const [confirmProcess, setConfirmProcess] = useState<string | null>(null);

  const mutating = closing !== null || closingProcess !== null || closingAll;
  const load = async () => {
    if (!available.current || inFlight.current || operation.current) return;
    inFlight.current = true;
    const epoch = readEpoch.current;
    setLoading(true);
    try {
      const data: any = await api.mihomo('GET', '/connections');
      if (!available.current || epoch !== readEpoch.current) return;
      setConns(data?.connections ?? []);
      setTotals({ up: data?.uploadTotal ?? 0, down: data?.downloadTotal ?? 0 });
      setLoadedAt(Date.now());
      setReadError(null);
    } catch (error) {
      if (available.current && epoch === readEpoch.current) setReadError(String(error));
    } finally {
      inFlight.current = false;
      if (available.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (!connected) {
      setConns([]); setTotals({ up: 0, down: 0 }); setLoadedAt(null); setReadError(null);
    }
    if (!active || !connected) return;
    const stop = startPolling(load, 2000);
    return () => { readEpoch.current += 1; stop(); };
  }, [active, connected]);

  const beginClose = () => {
    if (!available.current || operation.current) return false;
    operation.current = true;
    readEpoch.current += 1;
    setConfirmCloseAll(false); setConfirmProcess(null);
    return true;
  };

  const close = async (id: string) => {
    if (!beginClose()) return;
    setClosing(id);
    try {
      await api.mihomo('DELETE', `/connections/${encodeURIComponent(id)}`);
      setConns((prev) => prev.filter((c) => c.id !== id));
    } catch (e) {
      notify('error', `关闭连接失败：${String(e)}`);
    } finally {
      operation.current = false;
      setClosing(null);
    }
  };


  const visible = useMemo(() => {
    if (view !== 'conn') return [];
    const q = deferredQuery.trim().toLowerCase();
    const list = (q
      ? conns.filter((c) =>
          `${hostOf(c)} ${c.metadata?.process ?? ''} ${(c.chains ?? []).join(' ')} ${c.rule ?? ''} ${c.rulePayload ?? ''}`
            .toLowerCase()
            .includes(q)
        )
      : [...conns]
    ).sort((a, b) => {
      if (sortBy === 'down') return (b.download ?? 0) - (a.download ?? 0);
      if (sortBy === 'up') return (b.upload ?? 0) - (a.upload ?? 0);
      return Date.parse(b.start) - Date.parse(a.start);
    });
    return list;
  }, [conns, deferredQuery, sortBy, view]);

  const processGroups = useMemo(() => {
    if (view !== 'process') return [];
    const q = deferredQuery.trim().toLowerCase();
    const map = new Map<
      string,
      { process: string; conns: RawConn[]; up: number; down: number; chains: Set<string> }
    >();
    for (const c of conns) {
      if (
        q &&
        !`${hostOf(c)} ${c.metadata?.process ?? ''} ${(c.chains ?? []).join(' ')} ${c.rule ?? ''}`
          .toLowerCase()
          .includes(q)
      ) {
        continue;
      }
      const name = c.metadata?.process || '未知进程';
      let g = map.get(name);
      if (!g) {
        g = { process: name, conns: [], up: 0, down: 0, chains: new Set() };
        map.set(name, g);
      }
      g.conns.push(c);
      g.up += c.upload ?? 0;
      g.down += c.download ?? 0;
      for (const ch of c.chains ?? []) g.chains.add(ch);
    }
    const list = [...map.values()];
    list.sort((a, b) =>
      sortBy === 'up' ? b.up - a.up : sortBy === 'down' ? b.down - a.down : a.process.localeCompare(b.process)
    );
    return list;
  }, [conns, deferredQuery, sortBy, view]);

  // 展开的连接与进程标题共用一个虚拟视口，避免每组创建滚动区或全量挂载。
  const processRows = useMemo(() => {
    type Row = { kind: 'group'; group: typeof processGroups[number] } | { kind: 'connection'; connection: RawConn };
    const rows: Row[] = [];
    for (const group of processGroups) {
      rows.push({ kind: 'group', group });
      if (expandedProcess === group.process) {
        for (const connection of group.conns) rows.push({ kind: 'connection', connection });
      }
    }
    return rows;
  }, [processGroups, expandedProcess]);

  const closeProcess = async (name: string, items: RawConn[]) => {
    if (!available.current || operation.current) return;
    if (confirmProcess !== name) {
      setConfirmProcess(name);
      window.setTimeout(() => setConfirmProcess((cur) => (cur === name ? null : cur)), 3000);
      return;
    }
    if (!beginClose()) return;
    setClosingProcess(name);
    try {
      const results = await Promise.allSettled(
        items.map((c) => api.mihomo('DELETE', `/connections/${encodeURIComponent(c.id)}`))
      );
      const closedIds = new Set(items.filter((_, index) => results[index].status === 'fulfilled').map(c => c.id));
      const failed = items.length - closedIds.size;
      setConns((prev) => prev.filter((c) => !closedIds.has(c.id)));
      if (!failed && expandedProcess === name) setExpandedProcess(null);
      notify(failed ? 'error' : 'success', failed
        ? `已关闭 ${closedIds.size} 条连接，${failed} 条失败，可重试`
        : `已关闭 ${name} 的 ${closedIds.size} 条连接`);
    } finally {
      operation.current = false;
      setClosingProcess(null);
    }
  };

  const closeAll = async () => {
    if (!available.current || operation.current) return;
    if (!confirmCloseAll) {
      setConfirmCloseAll(true);
      window.setTimeout(() => setConfirmCloseAll(false), 3000);
      return;
    }
    if (!beginClose()) return;
    setClosingAll(true);
    try {
      await api.mihomo('DELETE', '/connections');
      setConns([]);
      notify('success', '已关闭所有连接');
    } catch (e) {
      notify('error', `操作失败：${String(e)}`);
    } finally {
      operation.current = false;
      setClosingAll(false);
    }
  };

  return (
    <>
      <PageHeader title="连接" subtitle={connected ? `${conns.length} 个活动连接` : '内核未运行'} mobileSubtitle={connected ? `${conns.length} 个` : '未连接'}>
          <button
            type="button"
            className={isAndroid ? 'icon-btn' : 'btn'}
            aria-label={confirmCloseAll ? '确认关闭所有连接' : '关闭所有连接'}
            title={confirmCloseAll ? '确认关闭所有连接' : '关闭所有连接'}
            disabled={!active || !connected || conns.length === 0 || mutating}
            onClick={() => void closeAll()}
          >
            {isAndroid ? closingAll ? <Spinner small /> : <IconX size={18} /> : <>{closingAll ? <Spinner small /> : null}{confirmCloseAll ? '确认关闭' : '关闭所有连接'}</>}
          </button>
          <button
            type="button"
            className="icon-btn"
            title="刷新"
            aria-label="刷新"
            aria-busy={loading}
            disabled={!active || !connected || loading || mutating}
            onClick={() => void load()}
          >
            <IconRefresh size={15} />
          </button>

      </PageHeader>

      <div className="page-scroll page-fixed dp-page dp-connections">
        <div className="page-inner dp-connections-content">
          {connected && readError && <ReadError message={`${readError}${loadedAt ? '；当前为上次读取的数据' : ''}`} onRetry={() => void load()} busy={loading || mutating || !active} />}
          {!connected ? (
            <section className="card">
              <EmptyState
                icon={<IconActivity size={19} />}
                title="内核未运行"
                desc="连接后显示网络连接"
                action={
                  <PageLink page="overview" label="去概览" />
                }
              />
            </section>
          ) : !loadedAt && readError ? null : conns.length === 0 ? (
            <section className="card">
              <EmptyState
                icon={<IconActivity size={19} />}
                title={!loadedAt && loading ? '正在读取连接…' : '暂无活动连接'}
                loading={!loadedAt && loading}
              />
            </section>
          ) : (
            <>
              <div className="row conn-toolbar dp-table-toolbar">
                {!androidLayout && <Segmented ariaLabel="连接视图" value={view} onChange={setView}
                  options={[{ value: 'conn', label: '连接' }, { value: 'process', label: '按进程' }]} />}
                <span className="dp-tool-label">排序</span>
                <Segmented ariaLabel="连接排序" value={sortBy} onChange={setSortBy}
                  options={[{ value: 'time', label: '时间' }, { value: 'down', label: '下载' }, { value: 'up', label: '上传' }]} />
                <div className="spacer" />
                <div className="node-search">
                  <IconSearch size={12} />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
                    placeholder="搜索主机 / 进程 / 规则"
                    aria-label="搜索连接"
                    spellCheck={false}
                  />
                  {query && (
                    <button
                      type="button"
                      className="node-search-clear"
                      aria-label="清空搜索"
                      onClick={() => setQuery('')}
                    >
                      <IconX size={11} />
                    </button>
                  )}
                </div>
                <span className="dp-table-count">{view === 'conn' ? visible.length : processGroups.length} {view === 'conn' ? '条连接' : '个进程'} · 本会话 {formatBytes(totals.up + totals.down)}</span>
              </div>

              <section className="card card-flush connections-card">
                <div className={`dp-connection-columns${view === 'process' ? ' is-process' : ''}`} aria-hidden="true">
                  <span>{view === 'process' ? '进程与路由' : '目标与路由'}</span>
                  <span className="dp-traffic-columns"><span>上传</span><span>下载</span></span>
                  <span>操作</span>
                </div>
                {view === 'conn' ? (
                  <div className="list conn-list">
                    {visible.length === 0 && (
                      <EmptyState icon={<IconSearch size={19} />} title="没有匹配的连接" action={<button type="button" className="btn btn-sm" onClick={() => setQuery('')}>清除筛选</button>} />
                    )}
                    <VirtualList items={visible} rowHeight={rowHeight} maxHeight={560} label="活动连接列表" resetKey={`${deferredQuery}:${sortBy}`} itemKey={c => c.id} renderItem={c => (
                      <div key={c.id} className="conn-row">
                        <span className="conn-main">
                          <span className="conn-host" title={hostOf(c)}>{hostOf(c)}</span>
                          <span className="conn-sub" title={[c.metadata?.process, c.metadata?.network ?? 'tcp', c.chains?.join(' → '), [c.rule, c.rulePayload].filter(Boolean).join(' ')].filter(Boolean).join(' · ')}>
                            {c.metadata?.process ? `${c.metadata.process} · ` : ''}
                            {c.metadata?.network ?? 'tcp'}
                            {c.chains && c.chains.length > 0
                              ? ` · ${c.chains.join(' → ')}`
                              : ''}
                            {c.rule ? ` · ${c.rule}${c.rulePayload ? ` ${c.rulePayload}` : ''}` : ''}
                          </span>
                        </span>
                        <span className="conn-traffic">
                          <span className="dp-conn-up">↑ {formatBytes(c.upload)}</span><span className="dp-conn-down">↓ {formatBytes(c.download)}</span>
                        </span>
                        {!androidLayout && <button
                          type="button"
                          className="icon-btn danger"
                          title="断开此连接"
                          aria-label="断开此连接"
                          disabled={mutating || !active}
                          onClick={() => void close(c.id)}
                        >
                          {closing === c.id ? <Spinner small /> : <IconX size={12} />}
                        </button>}
                      </div>
                    )} />
                  </div>
                ) : (
                  <div className="list conn-list">
                    {processGroups.length === 0 && (
                      <EmptyState icon={<IconSearch size={19} />} title="没有匹配的连接" action={<button type="button" className="btn btn-sm" onClick={() => setQuery('')}>清除筛选</button>} />
                    )}
                    <VirtualList items={processRows} rowHeight={rowHeight} maxHeight={560} label="进程连接列表" resetKey={`${deferredQuery}:${sortBy}`} itemKey={row => row.kind === 'group' ? `group:${row.group.process}` : `conn:${row.connection.id}`} renderItem={row => {
                      if (row.kind === 'connection') {
                        const c = row.connection;
                        return <div className="conn-row proc-child">
                          <span className="conn-main">
                            <span className="conn-host" title={hostOf(c)}>{hostOf(c)}</span>
                            <span className="conn-sub">{c.metadata?.network ?? 'tcp'}{c.rule ? ` · ${c.rule}${c.rulePayload ? ` ${c.rulePayload}` : ''}` : ''}</span>
                          </span>
                          <span className="conn-traffic"><span className="dp-conn-up">↑ {formatBytes(c.upload)}</span><span className="dp-conn-down">↓ {formatBytes(c.download)}</span></span>
                        </div>;
                      }
                      const g = row.group;
                      const open = expandedProcess === g.process;
                      return (
                          <div className="conn-row proc-row">
                            <button
                              type="button"
                              className="proc-expand"
                              aria-label={`${open ? '收起' : '展开'} ${g.process} 的连接`}
                              aria-expanded={open}
                              onClick={() => setExpandedProcess(open ? null : g.process)}
                            >
                              {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
                            </button>
                            <span className="conn-main">
                              <span className="conn-host" title={g.process}>{g.process}</span>
                              <span className="conn-sub">
                                {g.conns.length} 条连接
                                {g.chains.size ? ` · ${[...g.chains].slice(0, 4).join(' → ')}` : ''}
                              </span>
                            </span>
                            <span className="conn-traffic">
                              <span className="dp-conn-up">↑ {formatBytes(g.up)}</span><span className="dp-conn-down">↓ {formatBytes(g.down)}</span>
                            </span>
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={mutating || !active}
                              onClick={() => void closeProcess(g.process, g.conns)}
                            >
                              {closingProcess === g.process ? '关闭中…' : confirmProcess === g.process ? '确认关闭' : '关闭进程连接'}
                            </button>
                          </div>
                      );
                    }} />
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </>
  );
}
