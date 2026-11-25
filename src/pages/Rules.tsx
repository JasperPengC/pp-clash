import { PageHeader } from '../components/PageHeader';
import { VirtualList } from '../components/VirtualList';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { usePageQuery, useViewPreference } from '../store/view-preferences';
import { EmptyState, MiniSwitch, ReadError, Segmented, Select, Spinner } from '../components/ui';
import { IconChevronDown, IconDownload, IconEdit, IconImport, IconInfo, IconPlus, IconRefresh, IconRules, IconSearch, IconTrash, IconX } from '../components/icons';
import { isAndroid } from '../core/platform';
import { getLifecycleToken, isLifecycleCurrent, useApp } from '../store/app';
import type { CustomRule } from '../domain/app';
import { parseSubscriptionRules } from '../core/subscription';
import type { RuleEditState } from '../core/generator';
import { api } from '../core/api';

interface KernelRule {
  type: string;
  payload: string;
  proxy: string;
}

const RULE_TYPES = [
  { value: 'DOMAIN-SUFFIX', label: 'DOMAIN-SUFFIX · 域名后缀' },
  { value: 'DOMAIN-KEYWORD', label: 'DOMAIN-KEYWORD · 域名关键字' },
  { value: 'DOMAIN', label: 'DOMAIN · 完整域名' },
  { value: 'IP-CIDR', label: 'IP-CIDR · IPv4 网段' },
  { value: 'IP-CIDR6', label: 'IP-CIDR6 · IPv6 网段' },
  { value: 'GEOIP', label: 'GEOIP · 国家/地区' },
  { value: 'DST-PORT', label: 'DST-PORT · 目标端口' },
  { value: 'PROCESS-NAME', label: 'PROCESS-NAME · 进程名' },
  { value: 'NETWORK', label: 'NETWORK · 协议（tcp/udp）' },
  { value: 'MATCH', label: 'MATCH · 兜底匹配' },
];

function newId() {
  return `rule-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
}

export function RulesPage() {
  const connected = useApp((s) => s.kernelPhase === 'running');
  const connectedAt = useApp((s) => s.connectedAt);
  const settings = useApp((s) => s.settings);
  const groups = useApp((s) => s.groups);
  const profiles = useApp((s) => s.profiles);
  const activeId = useApp((s) => s.activeId);
  const updateRuleEdits = useApp((s) => s.updateRuleEdits);
  const updateSettings = useApp((s) => s.updateSettings);
  const notify = useApp((s) => s.notify);

  const rules = settings.customRules;
  const [compactLayout, setCompactLayout] = useState(() => isAndroid && window.matchMedia('(max-width: 599px)').matches);
  useEffect(() => {
    if (!isAndroid) return;
    const query = window.matchMedia('(max-width: 599px)');
    const update = () => setCompactLayout(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const [kernelRules, setKernelRules] = useState<KernelRule[]>([]);
  const [kernelLoading, setKernelLoading] = useState(connected);
  const [kernelError, setKernelError] = useState<string | null>(null);
  const kernelRequest = useRef(0);
  const kernelReading = useRef(false);
  const mutationBusy = useRef(false);
  const [query, setQuery] = usePageQuery('rules');
  const [ruleView, setRuleView] = useViewPreference('ruleView');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [type, setType] = useState('DOMAIN-SUFFIX');
  const [payload, setPayload] = useState('');
  const [target, setTarget] = useState('__CURRENT__');
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  const [showIO, setShowIO] = useState(false);
  const [ioText, setIoText] = useState('');
  const [subQuery, setSubQuery] = usePageQuery(JSON.stringify(['subscription-rules', activeId]));
  const deferredQuery = useDeferredValue(query);
  const deferredSubQuery = useDeferredValue(subQuery);
  const [ruleSaving, setRuleSaving] = useState(false);
  const busy = saving || ruleSaving;

  const targetOptions = useMemo(() => {
    const base = [
      { value: '__CURRENT__', label: '当前节点（自动）' },
      { value: 'DIRECT', label: 'DIRECT · 直连' },
      { value: 'REJECT', label: 'REJECT · 拒绝' },
      ...groups.map((g) => ({ value: g.name, label: g.name })),
    ];
    if (target && !base.some((o) => o.value === target)) {
      base.push({ value: target, label: target });
    }
    return base;
  }, [groups, target]);

  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeId) ?? null,
    [profiles, activeId]
  );
  const subscriptionRules = useMemo(
    () => parseSubscriptionRules(activeProfile?.raw ?? ''),
    [activeProfile?.raw]
  );
  const fullOrder = useMemo(() => {
    const saved = activeProfile?.ruleEdits?.order ?? [];
    const seen = new Set<number>();
    const out: number[] = [];
    for (const i of saved) {
      if (i >= 0 && i < subscriptionRules.length && !seen.has(i)) {
        seen.add(i);
        out.push(i);
      }
    }
    for (let i = 0; i < subscriptionRules.length; i += 1) {
      if (!seen.has(i)) out.push(i);
    }
    return out;
  }, [activeProfile?.ruleEdits?.order, subscriptionRules]);

  const orderedSubscriptionRules = useMemo(
    () => fullOrder.map((i) => subscriptionRules[i]).filter(Boolean),
    [fullOrder, subscriptionRules]
  );

  const filteredSubscriptionRules = useMemo(() => {
    const q = deferredSubQuery.trim().toLowerCase();
    if (!q) return orderedSubscriptionRules;
    return orderedSubscriptionRules.filter((r) =>
      `${r.type} ${r.payload} ${r.target}`.toLowerCase().includes(q)
    );
  }, [orderedSubscriptionRules, deferredSubQuery]);

  const ruleTargetOptions = (current: string) => {
    const base = [
      { value: 'DIRECT', label: 'DIRECT · 直连' },
      { value: 'REJECT', label: 'REJECT · 拒绝' },
      ...groups.map((g) => ({ value: g.name, label: g.name })),
    ];
    if (current && !base.some((o) => o.value === current)) {
      base.unshift({ value: current, label: current });
    }
    return base;
  };

  const saveRuleEdit = async (index: number, patch: { enabled?: boolean; target?: string }) => {
    if (!activeProfile || mutationBusy.current) return;
    const prev = activeProfile.ruleEdits ?? { order: fullOrder, edits: {} };
    const next: RuleEditState = {
      order: prev.order.length ? prev.order : fullOrder,
      edits: { ...prev.edits, [index]: { ...prev.edits[index], ...patch } },
    };
    mutationBusy.current = true;
    setRuleSaving(true);
    try {
      await updateRuleEdits(next);
    } catch (error) {
      notify('error', `订阅规则保存失败：${String(error)}`);
    } finally {
      mutationBusy.current = false;
      setRuleSaving(false);
    }
  };

  const moveSubscriptionRule = async (index: number, dir: -1 | 1) => {
    if (!activeProfile || mutationBusy.current) return;
    const pos = fullOrder.indexOf(index);
    const targetPos = pos + dir;
    if (pos < 0 || targetPos < 0 || targetPos >= fullOrder.length) return;
    const order = [...fullOrder];
    [order[pos], order[targetPos]] = [order[targetPos], order[pos]];
    const prev = activeProfile.ruleEdits ?? { order: [], edits: {} };
    mutationBusy.current = true;
    setRuleSaving(true);
    try {
      await updateRuleEdits({ ...prev, order });
    } catch (error) {
      notify('error', `订阅规则保存失败：${String(error)}`);
    } finally {
      mutationBusy.current = false;
      setRuleSaving(false);
    }
  };

  const resetSubscriptionRules = async () => {
    if (!activeProfile || mutationBusy.current) return;
    mutationBusy.current = true;
    setRuleSaving(true);
    try {
      await updateRuleEdits({ order: [], edits: {} });
    } catch (error) {
      notify('error', `订阅规则重置失败：${String(error)}`);
    } finally {
      mutationBusy.current = false;
      setRuleSaving(false);
    }
  };

  const loadKernelRules = useCallback(async () => {
    if (!connected || kernelReading.current) return;
    kernelReading.current = true;
    const request = ++kernelRequest.current;
    setKernelLoading(true);
    setKernelError(null);
    try {
      const data: any = await api.mihomo('GET', '/rules');
      if (!Array.isArray(data?.rules)) throw new Error('内核返回的规则列表无效');
      if (request === kernelRequest.current) setKernelRules(data.rules);
    } catch (error) {
      if (request === kernelRequest.current) setKernelError(`生效规则读取失败：${String(error)}`);
    } finally {
      if (request === kernelRequest.current) {
        kernelReading.current = false;
        setKernelLoading(false);
      }
    }
  }, [connected, settings.controllerPort, settings.controllerSecret]);

  useEffect(() => {
    setKernelRules([]);
    setKernelError(null);
    setKernelLoading(connected);
    void loadKernelRules();
    return () => {
      kernelRequest.current += 1;
      kernelReading.current = false;
    };
  }, [loadKernelRules, connected, connectedAt, activeId]);

  const resetEditor = () => {
    setEditingId(null);
    setType('DOMAIN-SUFFIX');
    setPayload('');
    setTarget('__CURRENT__');
    setEnabled(true);
  };

  const persist = async (next: CustomRule[], note: string) => {
    if (mutationBusy.current) return false;
    mutationBusy.current = true;
    setSaving(true);
    const token = getLifecycleToken();
    const previous = useApp.getState().settings.customRules;
    try {
      updateSettings({ customRules: next });
      const st = useApp.getState();
      if (!st.profiles.some((profile) => profile.id === st.activeId)) {
        notify('info', `${note}，导入订阅并连接后生效`);
        return true;
      }
      const applied = await st.applyConfig();
      if (!isLifecycleCurrent(token)) return false;
      if (!applied) throw new Error('配置生成失败，请检查活动订阅后重试');
      if (st.kernelPhase === 'running' && !await st.restartKernel(true, token, true)) {
        throw new Error('内核重启失败，请检查内核状态后重试');
      }
      if (!isLifecycleCurrent(token)) return false;
      notify('success', note);
      void loadKernelRules();
      return true;
    } catch (error) {
      if (!isLifecycleCurrent(token)) return false;
      updateSettings({ customRules: previous });
      useApp.setState({ configPath: '' });
      notify('error', `规则应用失败：${String(error)}`);
      return false;
    } finally {
      mutationBusy.current = false;
      setSaving(false);
    }
  };

  const saveRule = async () => {
    if (mutationBusy.current) return;
    if (type !== 'MATCH' && !payload.trim()) {
      notify('error', '规则内容不能为空');
      return;
    }
    const rule: CustomRule = {
      id: editingId ?? newId(),
      type,
      payload: type === 'MATCH' ? '' : payload.trim(),
      target,
      enabled,
    };
    const next = editingId
      ? rules.map((r) => (r.id === editingId ? rule : r))
      : [...rules, rule];
    if (await persist(next, editingId ? '规则已更新' : '规则已添加')) { resetEditor(); setRuleView('custom'); }
  };

  const toggleRule = async (id: string, on: boolean) => {
    await persist(
      rules.map((r) => (r.id === id ? { ...r, enabled: on } : r)),
      on ? '规则已启用' : '规则已停用'
    );
  };

  const removeRule = async (id: string) => {
    const ok = await persist(
      rules.filter((r) => r.id !== id),
      '规则已删除'
    );
    if (ok && editingId === id) resetEditor();
  };

  const exportRules = () => {
    const text = JSON.stringify(
      rules.map(({ id: _id, ...rest }) => rest),
      null,
      2
    );
    setIoText(text);
    setShowIO(true);
    void navigator.clipboard
      ?.writeText(text)
      .then(() => notify('success', '已复制到剪贴板'))
      .catch(() => {});
  };

  const importRules = async () => {
    if (mutationBusy.current) return;
    try {
      const parsed = JSON.parse(ioText);
      if (!Array.isArray(parsed)) throw new Error('需要一个数组');
      const imported: CustomRule[] = parsed.map((r: any, i: number) => ({
        id: newId() + i,
        type: String(r.type ?? 'DOMAIN-SUFFIX'),
        payload: String(r.payload ?? ''),
        target: String(r.target ?? 'DIRECT'),
        enabled: r.enabled !== false,
      }));
      const key = (rule: CustomRule) => JSON.stringify([rule.type, rule.payload, rule.target]);
      const next = [...useApp.getState().settings.customRules];
      const seen = new Set(next.map(key));
      let added = 0;
      for (const rule of imported) {
        if (seen.has(key(rule))) continue;
        seen.add(key(rule)); next.push(rule); added += 1;
      }
      if (added === 0) { notify('info', '没有新增规则，原规则已保留'); return; }
      if (await persist(next, `已合并 ${added} 条新规则`)) {
        setShowIO(false);
        setIoText('');
        setRuleView('custom');
      }
    } catch (e) {
      notify('error', `导入失败：${(e as Error).message}`);
    }
  };

  const filteredKernel = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    if (!q) return kernelRules;
    return kernelRules.filter((r) =>
      `${r.type} ${r.payload} ${r.proxy}`.toLowerCase().includes(q)
    );
  }, [kernelRules, deferredQuery]);

  return (
    <>
      <PageHeader title="规则" subtitle={rules.length > 0 ? `${rules.length} 条自定义规则` : '自定义规则'} mobileSubtitle={null}>
          <button type="button" className={isAndroid ? 'icon-btn' : 'btn'} aria-label="导出规则" title="导出规则" onClick={exportRules} disabled={busy || rules.length === 0}>
            {isAndroid ? <IconDownload size={18} /> : '导出'}
          </button>
          <button type="button" className={isAndroid ? 'icon-btn' : 'btn'} aria-label="导入规则" title="导入规则" disabled={busy} onClick={() => setShowIO((v) => !v)}>
            {isAndroid ? <IconImport size={18} /> : '导入'}
          </button>
          <button
            type="button"
            className="icon-btn"
            title="刷新生效规则"
            aria-label="刷新生效规则"
            disabled={!connected || kernelLoading || busy}
            onClick={() => void loadKernelRules()}
          >
            <IconRefresh size={15} />
          </button>

      </PageHeader>

      <div className="page-scroll dp-page dp-rules">
        <div className="page-inner dp-rule-workspace">
          <section className="dp-rule-section dp-rule-editor" hidden={isAndroid && ruleView !== 'custom'}>
            <div className="dp-section-heading">
              <span className="section-title">{editingId ? '编辑规则' : '添加规则'}</span>
              <div className="spacer" />
              <span className="card-hint">启用</span>
              <MiniSwitch on={enabled} onChange={setEnabled} label="启用规则" disabled={busy} />
            </div>

            <div className="rule-builder">
              <Select
                value={type}
                options={RULE_TYPES}
                onChange={(v) => setType(v)}
                ariaLabel="规则类型"
                disabled={busy}
                className="rule-type-select"
              />
              {type !== 'MATCH' && (
                <input
                  className="input rule-payload"
                  value={payload}
                  onChange={(e) => setPayload(e.target.value)}
                  placeholder={
                    type === 'GEOIP' ? 'CN' : type === 'DST-PORT' ? '443' : '填写域名 / IP / 关键字'
                  }
                  aria-label="规则内容"
                  disabled={busy}
                  spellCheck={false}
                />
              )}
              <Select
                value={target}
                options={targetOptions}
                onChange={(v) => setTarget(v)}
                ariaLabel="规则目标"
                disabled={busy}
                className="rule-target-select"
              />
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void saveRule()}
                disabled={busy}
              >
                {saving ? <Spinner small /> : editingId ? null : <IconPlus size={12} />}
                {editingId ? '保存修改' : '添加'}
              </button>
              {editingId && (
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={resetEditor}>
                  取消
                </button>
              )}
            </div>
            {type === 'MATCH' && <div className="rule-hint">MATCH 匹配其余流量</div>}
          </section>

          {showIO && (
            <section className="dp-rule-section dp-rule-import">
              <div className="dp-section-heading">
                <span className="section-title">导入 / 导出</span>
                <div className="spacer" />
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => void importRules()}
                  disabled={busy}
                >
                  从文本导入
                </button>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setShowIO(false)}>
                  关闭
                </button>
              </div>
              <textarea
                className="override-editor rule-io"
                value={ioText}
                disabled={busy}
                aria-label="规则导入内容"
                onChange={(e) => setIoText(e.target.value)}
                placeholder='在这里粘贴规则 JSON，例如 [{"type":"DOMAIN-SUFFIX","payload":"example.com","target":"DIRECT","enabled":true}]'
                spellCheck={false}
              />
            </section>
          )}

          <div className="dp-rule-navigation">
            <Segmented ariaLabel="规则视图" value={ruleView} onChange={setRuleView} options={[
              { value: 'custom', label: <>自定义 <span>{rules.length}</span></> },
              { value: 'subscription', label: <>订阅 <span>{orderedSubscriptionRules.length}</span></> },
              { value: 'effective', label: <>生效 <span>{kernelRules.length}</span></> },
            ]} />
          </div>

          <section className="dp-rule-section dp-rule-custom" aria-label="自定义规则" hidden={ruleView !== 'custom'}>
            <div className="dp-section-heading">
              <div className="dp-section-title"><h2 className="section-title">自定义规则</h2><p>手动维护的匹配内容与目标</p></div>
              <div className="spacer" />
              <span className="card-hint">{rules.length} 条</span>
            </div>
            {rules.length === 0 ? (
              <div className="rule-empty">暂无自定义规则</div>
            ) : (
              <>
              <div className="dp-rule-columns" aria-hidden="true"><span>类型</span><span>内容</span><span>目标</span><span>操作</span></div>
              <VirtualList className="custom-rule-list" label="自定义规则列表" items={rules} rowHeight={compactLayout ? 96 : isAndroid ? 56 : 44}
                itemKey={r => r.id} renderItem={r => (
                  <div key={r.id} className="custom-rule-row">
                    <span className="dp-rule-type" title={r.type}>{r.type}</span>
                    <span className="custom-rule-payload" title={r.payload}>
                      {r.type === 'MATCH' ? '默认兜底' : r.payload}
                    </span>
                    <span className="custom-rule-target" title={r.target}>
                      {r.target === '__CURRENT__' ? '当前节点' : r.target}
                    </span>
                    <div className="dp-rule-actions">
                    <MiniSwitch
                      on={r.enabled}
                      onChange={(v) => void toggleRule(r.id, v)}
                      label="启用规则"
                      disabled={busy}
                    />
                    <button
                      type="button"
                      className="icon-btn"
                      title="编辑规则"
                      aria-label="编辑规则"
                      disabled={busy}
                      onClick={() => {
                        setEditingId(r.id);
                        setType(r.type);
                        setPayload(r.payload);
                        setTarget(r.target);
                        setEnabled(r.enabled);
                      }}
                    >
                      <IconEdit size={13} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn danger"
                      title="删除规则"
                      aria-label="删除规则"
                      disabled={busy}
                      onClick={() => void removeRule(r.id)}
                    >
                      <IconTrash size={13} />
                    </button>
                    </div>
                  </div>
                )} />
              </>
            )}
          </section>

          <section className="dp-rule-section dp-rule-subscription" aria-label="订阅规则" hidden={ruleView !== 'subscription'}>
            <div className="dp-section-heading">
              <div className="dp-section-title"><h2 className="section-title">订阅规则</h2><p>{activeProfile ? `来自 ${activeProfile.name}` : '来自活动订阅'}</p></div>
              <div className="spacer" />
              <span className="card-hint">
                {activeProfile
                  ? `${orderedSubscriptionRules.length} 条 · 可排序/启停`
                  : '先选择订阅'}
              </span>
              {activeProfile && orderedSubscriptionRules.length > 0 && (
                <button
                  type="button"
                  className={isAndroid ? 'icon-btn' : 'btn btn-ghost btn-sm'}
                  aria-label="重置订阅规则" title="重置订阅规则"
                  disabled={busy}
                  onClick={() => void resetSubscriptionRules()}
                >
                  {isAndroid ? <IconRefresh size={18} /> : '重置'}
                </button>
              )}
            </div>
            {!activeProfile ? (
              <div className="rule-empty">还没有活动订阅。</div>
            ) : orderedSubscriptionRules.length === 0 ? (
              <div className="rule-empty">当前订阅没有规则</div>
            ) : (
              <>
                <div className="dp-rule-filter">
                  <div className="node-search">
                    <IconSearch size={12} />
                    <input
                      value={subQuery}
                      onChange={(e) => setSubQuery(e.target.value)}
                      placeholder="搜索订阅规则"
                      aria-label="搜索订阅规则"
                      spellCheck={false}
                    />
                    {subQuery && (
                      <button
                        type="button"
                        className="node-search-clear"
                        aria-label="清空搜索"
                        onClick={() => setSubQuery('')}
                      >
                        <IconX size={11} />
                      </button>
                    )}
                  </div>
                  <span className="card-hint">
                    显示 {filteredSubscriptionRules.length} / {orderedSubscriptionRules.length}
                  </span>
                </div>
                <div className="dp-rule-columns" aria-hidden="true"><span>类型</span><span>内容</span><span>目标</span><span>操作</span></div>
                <VirtualList className="sub-rule-list" label="订阅规则列表" items={filteredSubscriptionRules} rowHeight={compactLayout ? 96 : isAndroid ? 56 : 44}
                  resetKey={`${activeId}:${deferredSubQuery}`} itemKey={r => r.index} renderItem={r => {
                    const edit = activeProfile.ruleEdits?.edits[r.index];
                    const on = edit?.enabled !== false;
                    const target = edit?.target || r.target;
                    return (
                      <div key={r.index} className={`sub-rule-row${on ? '' : ' is-off'}`}>
                        <span className="dp-rule-type" title={r.type}>{r.type}</span>
                        <span className="sub-rule-payload" title={r.raw}>
                          {r.type === 'MATCH' ? '默认兜底' : r.payload}
                        </span>
                        <Select
                          value={target}
                          options={ruleTargetOptions(target)}
                          onChange={(v) => void saveRuleEdit(r.index, { target: v })}
                          ariaLabel={`规则目标 ${r.type}`}
                          disabled={busy}
                          className="sub-rule-target"
                        />
                        <div className="dp-rule-actions">
                          <MiniSwitch
                            on={on}
                            onChange={(v) => void saveRuleEdit(r.index, { enabled: v })}
                            label="启用订阅规则"
                            disabled={busy}
                          />
                          <div className="sub-rule-move">
                          <button
                            type="button"
                            className="icon-btn"
                            title="上移订阅规则"
                            aria-label="上移订阅规则"
                            disabled={busy}
                            onClick={() => void moveSubscriptionRule(r.index, -1)}
                          >
                            <IconChevronDown className="dp-move-up" size={13} />
                          </button>
                          <button
                            type="button"
                            className="icon-btn"
                            title="下移订阅规则"
                            aria-label="下移订阅规则"
                            disabled={busy}
                            onClick={() => void moveSubscriptionRule(r.index, 1)}
                          >
                            <IconChevronDown size={13} />
                          </button>
                          </div>
                        </div>
                      </div>
                    );
                  }} />
              </>
            )}
          </section>

          <section className="dp-rule-section dp-rule-effective" aria-label="当前生效规则" hidden={ruleView !== 'effective'}>
            <div className="dp-section-heading">
              <div className="dp-section-title"><h2 className="section-title">当前生效规则</h2><p>内核当前返回的规则，只读</p></div>
              <div className="spacer" />
              <span className="card-hint">
                {!connected ? '内核未运行' : kernelLoading ? '读取中…' : kernelError ? '读取失败' : `${kernelRules.length} 条`}
              </span>
            </div>
            {connected && kernelError && <ReadError message={`${kernelError}${kernelRules.length ? '；当前为上次读取的规则' : ''}`} onRetry={() => void loadKernelRules()} busy={kernelLoading || busy} />}
            {connected && kernelLoading && <EmptyState icon={<IconRules size={19} />} title="正在读取生效规则" desc={kernelRules.length ? '当前为上次读取的规则' : undefined} loading />}
            {connected && kernelRules.length > 0 ? (
              <>
                <div className="dp-rule-filter">
                  <div className="node-search">
                    <IconSearch size={12} />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="搜索生效规则"
                      aria-label="搜索生效规则"
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
                    显示 {filteredKernel.length} / {kernelRules.length}
                  </span>
                </div>
                <div className="kernel-rule-list">
                  <div className="dp-rule-columns" aria-hidden="true">
                    <span>类型</span>
                    <span>内容</span>
                    <span>目标</span>
                  </div>
                  <VirtualList label="生效规则列表" items={filteredKernel} rowHeight={compactLayout ? 64 : 40} resetKey={deferredQuery}
                    maxHeight={340} itemKey={(r,i) => `${i}-${r.type}-${r.payload}`} renderItem={r => (
                    <div className="rule-row">
                      <span className="dp-rule-type" title={r.type}>{r.type}</span>
                      <span className="rule-payload" title={r.payload}>
                        {r.payload}
                      </span>
                      <span className="rule-proxy" title={r.proxy}>
                        {r.proxy}
                      </span>
                    </div>
                  )} />
                  {filteredKernel.length === 0 && <EmptyState icon={<IconSearch size={19} />} title="没有匹配的规则" action={<button type="button" className="btn btn-sm" onClick={() => setQuery('')}>清空筛选</button>} />}
                </div>
              </>
            ) : !connected || (!kernelLoading && !kernelError) ? (
              <EmptyState
                icon={<IconRules size={19} />}
                title={connected ? '暂无规则' : '内核未运行'}
                desc={connected ? '内核已连接，但尚未返回规则。' : '连接内核后可查看当前生效规则。'}
              />
            ) : null}
          </section>

          <div className="banner dp-rule-note">
            <IconInfo size={13} />
            <span>{isAndroid ? '安全防护规则只读。' : '安全规则只读；其他配置请在覆写页修改。'}</span>
          </div>
        </div>
      </div>
    </>
  );
}
