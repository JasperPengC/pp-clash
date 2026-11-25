import { PageHeader } from '../components/PageHeader';
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePageQuery, useViewPreference } from '../store/view-preferences';
import { EmptyState, ReadError, Segmented } from '../components/ui';
import { IconCode, IconDownload, IconPause, IconRefresh, IconSearch, IconX } from '../components/icons';
import { isAndroid } from '../core/platform';
import { IconLog } from '../components/icons';
import { useApp } from '../store/app';
import { api, isTauri } from '../core/api';
import { save } from '@tauri-apps/plugin-dialog';
import { startPolling } from '../core/polling';

import { logLineLevel, parseLogLine } from '../core/log-format';

export function LogsPage({ active = true }: { active?: boolean }) {
  const kernelPhase = useApp((s) => s.kernelPhase);
  const connected = kernelPhase === 'running';

  const [text, setText] = useState('');
  const [rawView, setRawView] = useViewPreference('logRaw');
  const [paused, setPaused] = useState(false);
  const [level, setLevel] = useViewPreference('logLevel');
  const [query, setQuery] = usePageQuery('logs');
  const [exporting, setExporting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const inFlight = useRef(false);
  const readEpoch = useRef(0);
  const available = useRef(active && !paused);
  available.current = active && !paused;
  const viewRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  const load = async () => {
    if (!available.current || inFlight.current) return;
    inFlight.current = true;
    const epoch = readEpoch.current;
    setLoading(true);
    try {
      const next = await api.readKernelLog(400);
      if (available.current && epoch === readEpoch.current) {
        setText(next); setReadError(null); setLoadedAt(Date.now());
      }
    } catch (error) {
      if (available.current && epoch === readEpoch.current) setReadError(String(error));
    } finally {
      inFlight.current = false;
      if (active) setLoading(false);
    }
  };

  useEffect(() => {
    if (paused || !active) return;
    const stop = startPolling(load, 1500);
    return () => {
      readEpoch.current += 1;
      stop();
    };
  }, [paused, active]);

  useEffect(() => {
    const el = viewRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  const lines = useMemo(() => text.split('\n').filter(line => line.trim()).map(parseLogLine), [text]);
  const shown = lines.filter(entry => {
    if (query && !entry.raw.toLowerCase().includes(query.toLowerCase())) return false;
    if (level === 'all') return true;
    return logLineLevel(entry) === level;
  });

  const exportLogs = async () => {
    if (!isTauri || exporting || shown.length === 0) return;
    setExporting(true);
    try {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const path = await save({
        defaultPath: `ppclash-logs-${stamp}.log`,
        filters: [{ name: '日志', extensions: ['log', 'txt'] }],
      });
      if (!path) return;
      await api.exportLogFile(path, shown.map(entry => entry.raw).join('\n') + '\n');
      useApp.getState().notify('success', '日志已导出');
    } catch (e) {
      useApp.getState().notify('error', `导出失败：${String(e)}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <PageHeader title="日志" subtitle={connected ? '内核日志 · 最近 400 行' : '内核未运行'} mobileSubtitle={null}>
          <button type="button" className={isAndroid ? 'icon-btn' : 'btn'} aria-label="原始日志" title="原始日志" aria-pressed={rawView} onClick={() => setRawView(value => !value)}>{isAndroid ? <IconCode size={18} /> : '原始日志'}</button>
          {isTauri && (
            <button
              type="button"
              className={isAndroid ? 'icon-btn' : 'btn'}
              aria-label="导出日志" title="导出日志"
              disabled={exporting || shown.length === 0}
              onClick={() => void exportLogs()}
            >
              <IconDownload size={isAndroid ? 18 : 13} />
              {!isAndroid && (exporting ? '导出中' : '导出')}
            </button>
          )}
          <button type="button" className={isAndroid ? 'icon-btn' : 'btn'} aria-label={paused ? '继续刷新' : '暂停'} title={paused ? '继续刷新' : '暂停'} aria-pressed={paused} onClick={() => setPaused((v) => !v)}>
            {isAndroid ? paused ? <IconRefresh size={18} /> : <IconPause size={18} /> : paused ? '继续刷新' : '暂停'}
          </button>

      </PageHeader>

      <div className="page-scroll page-fixed dp-page dp-logs">
        <div className="page-inner dp-log-workspace">
          {readError && <ReadError message={`${readError}${loadedAt ? '；当前为上次读取的日志' : ''}`} onRetry={() => { if (paused) setPaused(false); else void load(); }} busy={loading || !active} />}
            <div className="row log-toolbar dp-table-toolbar">
              <Segmented ariaLabel="日志级别" value={level} onChange={setLevel} options={[
                { value: 'all', label: '全部' }, { value: 'info', label: '信息' },
                { value: 'warn', label: '警告' }, { value: 'error', label: '错误' },
              ]} />
              <div className="node-search">
                <IconSearch size={12} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
                  placeholder="搜索日志"
                  aria-label="搜索日志"
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
              <span className="card-hint">
                显示 {shown.length} / {lines.length}
              </span>
              <div className="spacer" />
              <span className={`dp-log-status${paused ? ' is-paused' : ''}`} role="status">{paused ? '已暂停' : loading ? '读取中…' : '自动刷新'}</span>
            </div>

          {!loadedAt && readError ? null : lines.length === 0 ? (
            <section className="card">
              <EmptyState
                icon={<IconLog size={19} />}
                title={!loadedAt && loading && !paused ? '正在读取日志…' : connected ? '暂无日志' : '暂无日志 · 内核未运行'}
                loading={!loadedAt && loading && !paused}
              />
            </section>
          ) : shown.length === 0 ? (
            <section className="card">
              <EmptyState icon={<IconSearch size={19} />} title="没有匹配的日志" action={<button type="button" className="btn btn-sm" onClick={() => { setLevel('all'); setQuery(''); }}>清除筛选</button>} />
            </section>
          ) : (
            <section className="card card-flush log-card">
              <div
                className={`log-view${rawView ? ' log-view-raw' : ''}`}
                ref={viewRef}
                onScroll={(e) => {
                  const el = e.currentTarget;
                  atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
                }}
              >
                {shown.map((entry, i) => (
                  <div key={`${i}-${entry.raw.slice(0, 24)}`} className={`log-line${rawView || entry.level === 'plain' ? ' log-plain' : ' log-entry'}`}>
                    {rawView || entry.level === 'plain' ? entry.raw : <>
                      <time className="log-time" title={entry.timestamp} dateTime={entry.timestamp || undefined}>{entry.time || '—'}</time>
                      <span className={`log-level ${entry.level}`}>{({ info: '信息', warn: '警告', error: '错误', debug: '调试', plain: '' })[entry.level]}</span>
                      <div className="log-content"><span>{entry.message}</span>{entry.details && <span className="log-details">{entry.details}</span>}</div>
                    </>}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
