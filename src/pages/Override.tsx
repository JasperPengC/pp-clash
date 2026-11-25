import { useEffect, useMemo, useRef, useState } from 'react';
import { useViewPreference } from '../store/view-preferences';
import { EmptyState, MiniSwitch, Segmented, Spinner, Toggle } from '../components/ui';
import CodeEditor from '../components/CodeEditor';
import { validateOverrideSource } from '../core/override-syntax';
import { IconChevronDown, IconCode, IconPlus, IconTrash } from '../components/icons';
import { getLifecycleToken, isLifecycleCurrent, useApp } from '../store/app';
import type { OverrideFile } from '../domain/app';

const PLACEHOLDER_YAML = `# YAML / JSON 片段，合并到生成的配置
# 对象按 key 合并；数组按条目追加，同一规则或同名对象会替换对应项
#
# rules:
#   - DOMAIN-SUFFIX,example.com,DIRECT
# dns:
#   nameserver:
#     - https://dns.google/dns-query
`;

const PLACEHOLDER_JS = `// 修改并返回 config；不支持网络和系统接口
config.mode = "global";
config["log-level"] = "debug";
return config;
`;

function validateOverride(file: OverrideFile): string | null {
  const text = file.text.trim();
  if (!text) return null;
  return validateOverrideSource(file.text, file.mode)[0]?.message ?? null;
}

function newOverride(index: number): OverrideFile {
  return {
    id: `override-${Date.now()}-${index}`,
    name: `覆写 ${index}`,
    mode: 'yaml',
    enabled: true,
    text: '',
  };
}

// 只在当前进程内保留草稿，切页不会丢失；不写入运行配置。
const draftCache = new Map<string, OverrideFile>();

export function OverridePage() {
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  const notify = useApp((s) => s.notify);

  const files = settings.overrides;
  const [selectedId, setSelectedId] = useViewPreference('overrideId');
  const selected = useMemo(
    () => files.find((f) => f.id === selectedId) ?? files[0],
    [files, selectedId]
  );

  const [drafts, setDrafts] = useState(() => new Map(draftCache));
  const draft = selected ? drafts.get(selected.id) ?? selected : undefined;
  const name = draft?.name ?? '';
  const mode = draft?.mode ?? 'yaml';
  const text = draft?.text ?? '';
  const enabled = draft?.enabled ?? true;
  const [diagnostics, setDiagnostics] = useState<ReturnType<typeof validateOverrideSource>>([]);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const applying = useRef(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const draftDirty = !!selected && !!draft && (
    name !== selected.name || mode !== selected.mode || text !== selected.text || enabled !== selected.enabled
  );
  const edit = (patch: Partial<OverrideFile>) => {
    if (!selected || !draft) return;
    const next = { ...draft, ...patch };
    draftCache.set(selected.id, next);
    setDrafts(prev => new Map(prev).set(selected.id, next));
  };
  const discard = () => {
    if (!selected) return;
    draftCache.delete(selected.id);
    setDrafts(prev => { const next = new Map(prev); next.delete(selected.id); return next; });
    setError(null);
  };
  useEffect(() => { setError(null); setConfirmDelete(false); }, [selected?.id]);

  useEffect(() => {
    let current = true;
    setChecking(true);
    const timer = window.setTimeout(() => {
      const result = validateOverrideSource(text, mode);
      if (current) { setDiagnostics(result); setChecking(false); }
    }, 180);
    return () => { current = false; window.clearTimeout(timer); };
  }, [mode, text, selected?.id]);

  useEffect(() => {
    if (files.length > 0 && !files.some((f) => f.id === selectedId)) {
      setSelectedId(files[0].id);
    }
    if (files.length === 0 && selectedId) setSelectedId('');
  }, [files, selectedId]);

  const selectFile = (id: string) => setSelectedId(id);

  const add = () => {
    if (applying.current) return;
    const file = newOverride(files.length + 1);
    updateSettings({ overrides: [...files, file] });
    setSelectedId(file.id);
  };

  const apply = async (nextFiles: OverrideFile[], note: string): Promise<boolean> => {
    if (applying.current) return false;
    const token = getLifecycleToken();
    applying.current = true;
    setSaving(true);
    try {
    for (const file of nextFiles) {
      if (!file.enabled) continue;
      const problem = validateOverride(file);
      if (problem) {
        setError(`${file.name}：${problem}`);
        notify('error', `覆写「${file.name}」语法检查失败`);
        return false;
      }
    }
    setError(null);
    updateSettings({ overrides: nextFiles });
    const st = useApp.getState();
    if (!st.profiles.some(p => p.id === st.activeId)) {
      notify('success', '覆写已保存，导入订阅并连接后生效');
      return true;
    }
    const applied = await st.applyConfig();
    if (!isLifecycleCurrent(token)) return false;
    if (!applied) {
      setError('修改已保存，但配置生成失败，请检查后重新应用');
      notify('error', '配置生成失败，当前修改未应用');
      return false;
    }
    if (st.kernelPhase === 'running') {
      const ok = await st.restartKernel(true, token, true);
      if (!isLifecycleCurrent(token)) return false;
      if (!ok) {
        setError('修改已保存，但内核未能重新连接，请重试连接');
        notify('error', '内核重启失败，当前修改未生效');
        return false;
      }
    }
    notify('success', note);
    return true;
    } catch (e) {
      if (!isLifecycleCurrent(token)) return false;
      setError(String(e));
      notify('error', `应用失败：${String(e)}`);
      return false;
    } finally {
      applying.current = false;
      setSaving(false);
    }
  };

  const save = async () => {
    if (!selected || applying.current) return;
    const finalName = name.trim() || selected.name;

    const candidate: OverrideFile = {
      ...selected,
      name: finalName,
      mode,
      enabled,
      text,
    };
    const problem = validateOverride(candidate);
    if (problem) {
      setError(problem);
      return;
    }

    setError(null);
    const next = files.map((f) =>
      f.id === selected.id ? { ...f, name: finalName, mode, enabled, text } : f
    );
    if (await apply(next, `已保存「${finalName}」`)) discard();
  };

  const remove = async () => {
    if (!selected || applying.current) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      window.setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    setConfirmDelete(false);
    const next = files.filter((f) => f.id !== selected.id);
    await apply(next, '覆写已删除');
    if (!useApp.getState().settings.overrides.some(f => f.id === selected.id)) discard();
  };

  const move = async (dir: -1 | 1) => {
    if (!selected || applying.current) return;
    const index = files.findIndex((f) => f.id === selected.id);
    const target = index + dir;
    if (index < 0 || target < 0 || target >= files.length) return;
    const next = [...files];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    await apply(next, '覆写顺序已更新');
  };

  const canMoveUp = selected ? files.findIndex((f) => f.id === selected.id) > 0 : false;
  const canMoveDown = selected
    ? files.findIndex((f) => f.id === selected.id) < files.length - 1
    : false;

  const toggleFile = async (file: OverrideFile, on: boolean) => {
    if (applying.current) return;
    if (drafts.has(file.id)) {
      const next = { ...drafts.get(file.id)!, enabled: on };
      draftCache.set(file.id, next);
      setDrafts(prev => new Map(prev).set(file.id, next));
    }
    await apply(
      files.map((f) => (f.id === file.id ? { ...f, enabled: on } : f)),
      on ? '覆写已启用' : '覆写已停用'
    );
  };

  const enabledCount = files.filter((f) => f.enabled).length;

  return (
    <>
      <header className="page-head">
        <div className="page-heading">
          <h1 className="page-title">覆写</h1>
          <div className="page-sub">
            {files.length > 0
              ? `${files.length} 个文件 · ${enabledCount} 个启用，按列表顺序合并`
              : '按列表顺序应用'}
          </div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={add} disabled={saving}>
            <IconPlus size={13} />
            新建覆写
          </button>
        </div>
      </header>

      <div className="page-scroll dp-page dp-override">
        <div className="page-inner">
          {files.length === 0 ? (
            <section className="card">
              <EmptyState
                icon={<IconCode size={19} />}
                title="还没有覆写"
                desc="添加 YAML 或 JavaScript 修改配置。"
                action={
                  <button type="button" className="btn btn-primary" onClick={add} disabled={saving}>
                    新建覆写
                  </button>
                }
              />
            </section>
          ) : (
            <div className="override-layout dp-override-workspace">
              <section className="card card-flush override-files">
                <div className="override-files-head">
                  <span>覆写文件</span>
                  <span>{files.length}</span>
                </div>
                {files.map((f) => (
                  <div
                    key={f.id}
                    className={`override-file${f.id === selected?.id ? ' active' : ''}`}
                  >
                    <button type="button" className="override-file-select" disabled={saving} aria-pressed={f.id === selected?.id} onClick={() => selectFile(f.id)}>
                    <span className={`override-dot${f.enabled ? ' on' : ''}`} />
                    <span className="override-file-name">{f.name}</span>
                    <span className="override-mode">{f.mode === 'js' ? 'JS' : 'YAML'}</span>
                    </button>
                    <MiniSwitch
                      disabled={saving}
                      on={f.enabled}
                      onChange={(v) => void toggleFile(f, v)}
                      label={f.enabled ? '停用覆写' : '启用覆写'}
                    />
                  </div>
                ))}
                <button type="button" className="override-file-add" onClick={add} disabled={saving}>
                  <IconPlus size={12} />
                  新建覆写
                </button>
              </section>

              <section className="card override-editor-card">
                <div className="override-toolbar">
                  <input
                    className="input override-name"
                    value={name}
                    disabled={saving}
                    onChange={(e) => edit({ name: e.target.value })}
                    aria-label="覆写名称"
                    spellCheck={false}
                  />
                  <Segmented
                    ariaLabel="覆写类型"
                    disabled={saving}
                    options={[
                      { value: 'yaml', label: 'YAML' },
                      { value: 'js', label: 'JS' },
                    ]}
                    value={mode}
                    onChange={(v) => edit({ mode: v })}
                  />
                  <div className="row" style={{ gap: 7 }}>
                    <span className="card-hint">启用</span>
                    <Toggle on={enabled} onChange={v => edit({ enabled: v })} disabled={saving} label="启用覆写" />
                  </div>
                  <div className="spacer" />
                  <button
                    type="button"
                    className="icon-btn"
                    title="上移（更早合并）"
                    aria-label="上移"
                    disabled={saving || !canMoveUp}
                    onClick={() => void move(-1)}
                  >
                    <IconChevronDown className="dp-move-up" size={13} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title="下移（更晚合并）"
                    aria-label="下移"
                    disabled={saving || !canMoveDown}
                    onClick={() => void move(1)}
                  >
                    <IconChevronDown size={13} />
                  </button>
                  <button
                    type="button"
                    className={`icon-btn danger${confirmDelete ? ' confirming' : ''}`}
                    title={confirmDelete ? '再点一次删除' : '删除覆写'}
                    aria-label={confirmDelete ? '确认删除' : '删除覆写'}
                    disabled={saving}
                    onClick={() => void remove()}
                  >
                    {confirmDelete ? <span className="t-micro">确认删除</span> : <IconTrash size={14} />}
                  </button>
                </div>

                <div className="dp-override-document">
                  <CodeEditor value={text} mode={mode} disabled={saving}
                    placeholder={mode === 'yaml' ? PLACEHOLDER_YAML : PLACEHOLDER_JS}
                    diagnostics={diagnostics} checking={checking}
                    onChange={value => edit({ text: value })} />
                  {mode === 'js' && (
                    <div className="override-error" style={{ color: 'var(--warning)' }}>
                      脚本运行超过 300ms 会终止。
                    </div>
                  )}
                  {error && <div className="override-error">{error}</div>}
                </div>

                <div className="override-foot">
                  <span className="card-hint" role="status">
                    {draftDirty ? '未保存 · 草稿已保留' : '{{CURRENT_NODE}} 代表当前节点'}
                  </span>
                  <div className="spacer" />
                  {draftDirty && <button type="button" className="btn" disabled={saving} onClick={discard}>撤销修改</button>}
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void save()}
                    disabled={saving}
                  >
                    {saving ? <Spinner small /> : null}
                    保存并应用
                  </button>
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
