import { useId, useRef, useState } from 'react';
import { useApp } from '../store/app';
import type { CollectionRecipe, Profile } from '../domain/app';
import { isAndroid } from '../core/platform';
import { Dialog } from './Dialog';
import { IconCheck, IconX } from './icons';
import './profile-collection.css';

const initialRules: CollectionRecipe = { sources: [], include: '', exclude: '', find: '', replace: '' };
export function ProfileCollectionDialog({ profile, onClose }: { profile?: Profile; onClose: () => void }) {
  const title = useId();
  const profiles = useApp(s => s.profiles);
  const active = useApp(s => s.activeId);
  const candidates = profiles.filter(p => p.sourceType !== 'collection');
  const [name, setName] = useState(profile?.name ?? '');
  const [recipe, setRecipe] = useState<CollectionRecipe>(profile?.collection ?? initialRules);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const change = (patch: Partial<CollectionRecipe>) => { setRecipe(v => ({ ...v, ...patch })); setError(''); };
  const readonly = !!profile && profile.id === active;
  const selected = recipe.sources.filter(id => candidates.some(p => p.id === id));
  const disabled = saving || readonly;
  return <Dialog labelledBy={title} busy={saving} onDismiss={onClose}>
    <form className="collection-editor" onSubmit={async event => {
      event.preventDefault();
      if (lock.current || readonly) return;
      lock.current = true; setSaving(true); setError('');
      try {
        await useApp.getState().saveCollection(name, { ...recipe, sources: selected }, profile?.id);
        useApp.getState().notify('success', profile ? '订阅组合已更新' : '订阅组合已创建'); onClose();
      } catch (e) { setError(e instanceof Error ? e.message : '无法保存订阅组合'); }
      finally { lock.current = false; setSaving(false); }
    }}>
      <header><h3 id={title}>{profile ? '编辑组合' : '组合订阅'}</h3><button type="button" className="icon-btn" disabled={saving} aria-label="关闭组合订阅" onClick={onClose}><IconX size={16}/></button></header>
      <label>组合名称<input autoFocus={!isAndroid} className="input" value={name} placeholder="例如：日常节点" maxLength={80} disabled={disabled} onChange={e => setName(e.target.value)} /></label>
      <fieldset disabled={disabled}><legend>来源订阅 <small>已选 {selected.length} 份</small></legend>
        <div className="collection-sources">{candidates.map(p => <button className="btn" key={p.id} type="button" aria-pressed={selected.includes(p.id)}
          disabled={!selected.includes(p.id) && selected.length >= 32}
          onClick={() => change({ sources: selected.includes(p.id) ? selected.filter(id => id !== p.id) : [...selected, p.id] })}>
          <span>{p.name}</span>{selected.includes(p.id) && <IconCheck size={14} />}</button>)}</div>
        {candidates.length < 2 && <p>先添加两份来源订阅，再组合节点。</p>}
      </fieldset>
      <div className="collection-fields">{([['include','只保留包含'],['exclude','排除包含'],['find','查找名称中的文字'],['replace','替换为']] as const).map(([key,label]) =>
        <label key={key}>{label}<input className="input" maxLength={128} value={recipe[key]} placeholder="可选" disabled={disabled}
          onChange={e => change({ [key]: e.target.value })} /></label>)}</div>
      <p>由本机 Sub-Store 生成。刷新组合会重新读取来源，原订阅保持不变。</p>
      {readonly && <p>切换到其他订阅后可编辑这个组合。</p>}
      {error && <p role="alert">{error}</p>}
      <footer><button className="btn btn-primary" disabled={disabled || !name.trim() || selected.length < 2}>{saving ? '正在生成…' : profile ? '保存组合' : '创建组合'}</button></footer>
    </form>
  </Dialog>;
}
