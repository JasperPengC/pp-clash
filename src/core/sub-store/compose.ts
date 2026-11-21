export interface CollectionRules { include: string; exclude: string; find: string; replace: string }
type Proxy = Record<string, unknown> & { name: string };
interface Engine { parse: (text: string) => unknown; produce: (nodes: Proxy[], target: string, format: string) => unknown }
const MAX_CHARS = 8 * 1024 * 1024;
const MAX_NODES = 10000;
const isProxy = (value: unknown): value is Proxy => value !== null && typeof value === 'object'
  && 'name' in value && typeof value.name === 'string' && !!value.name.trim();

export function composeCollection(sources: string[], rules: CollectionRules, engine: Engine) {
  if (sources.length < 2 || sources.length > 32) throw new Error('请选择 2 至 32 个来源订阅');
  if (sources.reduce((sum, raw) => sum + raw.length, 0) > MAX_CHARS) throw new Error('来源订阅内容过大');
  const include = rules.include.trim().toLowerCase(), exclude = rules.exclude.trim().toLowerCase();
  const nodes: Proxy[] = [];
  const used = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'GLOBAL', 'COMPATIBLE', '节点选择']);
  const suffixes = new Map<string, number>();
  let count = 0;
  for (const [index, raw] of sources.entries()) {
    const parsed = engine.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length || !parsed.every(isProxy)) throw new Error(`第 ${index + 1} 个来源没有可读取的节点`);
    count += parsed.length;
    if (count > MAX_NODES) throw new Error('来源节点超过 10000 个');
    const picked = parsed.filter(p => {
      const name = p.name.toLowerCase();
      return (!include || name.includes(include)) && (!exclude || !name.includes(exclude));
    });
    const normalized: unknown = engine.produce(picked, 'Mihomo', 'internal');
    if (!Array.isArray(normalized) || !normalized.every(isProxy)) throw new Error('无法生成 Mihomo 节点');
    const bindings = new Map<string, string>();
    const group: Proxy[] = [];
    for (const p of normalized) {
      const base = (rules.find ? p.name.split(rules.find).join(rules.replace) : p.name).trim();
      if (!base) throw new Error('替换后的节点名称不能为空');
      let name = base, next = suffixes.get(base) ?? 2;
      while (used.has(name)) name = `${base} (${next++})`;
      suffixes.set(base, next); used.add(name);
      if (!bindings.has(p.name)) bindings.set(p.name, name);
      group.push({ ...p, name });
    }
    for (const p of group) {
      const via = p['dialer-proxy'];
      if (typeof via === 'string' && via && via !== 'DIRECT') {
        const bound = bindings.get(via);
        if (!bound) throw new Error('节点依赖未包含的前置代理，请调整筛选条件或来源');
        p['dialer-proxy'] = bound;
      }
    }
    nodes.push(...group);
  }
  if (!nodes.length) throw new Error('筛选后没有可用节点');
  // JSON 是 YAML 的子集；节点名与协议字段全部由序列化器转义。
  const raw = JSON.stringify({ proxies: nodes, 'proxy-groups': [{ name: '节点选择', type: 'select', proxies: nodes.map(n => n.name) }], rules: ['MATCH,节点选择'] });
  if (raw.length > MAX_CHARS) throw new Error('生成的订阅内容过大');
  return { raw, nodes };
}
