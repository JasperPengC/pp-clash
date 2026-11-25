export const resolverProviders = ['Google', 'IP-API', 'Cloudflare', 'Ali', 'Tencent', 'Custom'];
export const resolverNumbers = [['timeout', 'DNS 超时（毫秒）'], ['concurrency', '域名并发数'], ['dnsConcurrency', '多 DNS 并发数'], ['cacheTtl', '缓存时长（秒）']] as const;

function literalIP(value: string): boolean {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return value.split('.').every(part => Number(part) <= 255 && (part === '0' || !part.startsWith('0')));
  if (!value.includes(':') || /[\[\]%/]/.test(value)) return false;
  try { return new URL(`http://[${value}]/`).hostname.startsWith('['); } catch { return false; }
}

function dnsAddressValid(raw: string): boolean {
  if (literalIP(raw)) return true;
  try {
    // Bare DNS hosts and host:port are accepted by the official UDP resolver.
    const parsed = new URL(raw.includes('://') ? raw : `udp://${raw}`);
    if (!parsed.hostname || !['http:', 'https:', 'udp:', 'tcp:', 'tls:'].includes(parsed.protocol)) return false;
    if (parsed.port && (!Number.isInteger(Number(parsed.port)) || Number(parsed.port) < 1 || Number(parsed.port) > 65535)) return false;
    if (['http:', 'https:'].includes(parsed.protocol)) return true;
    return !parsed.username && !parsed.password && (!parsed.pathname || parsed.pathname === '/') && !parsed.search && !parsed.hash;
  } catch { return false; }
}

export function resolveDomainError(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '域名解析参数必须是 JSON 对象';
  const args = value as Record<string, unknown>;
  if (typeof args.provider !== 'string' || !resolverProviders.includes(args.provider)) return '请选择有效的解析服务';
  if (args.provider === 'IP-API' && ['IPv6', 'IP4P'].includes(String(args.type))) return `IP-API 不支持 ${String(args.type)}，请选择其他解析服务或 IPv4`;
  for (const [key, label] of resolverNumbers) {
    const raw = args[key];
    if (raw == null || (typeof raw === 'string' && !raw.trim())) continue;
    if (!['string', 'number'].includes(typeof raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) return `${label}必须是正整数，留空沿用默认设置`;
  }
  if (args.edns && (typeof args.edns !== 'string' || !literalIP(args.edns))) return 'EDNS 地址必须是 IPv4 或 IPv6 地址，留空沿用默认设置';
  if (args.provider === 'Custom') {
    if (typeof args.url !== 'string' || !args.url.trim()) return '请输入自定义 DNS 地址，每行一个';
    const lines = args.url.split('\n');
    for (let index = 0; index < lines.length; index++) if (lines[index].trim() && !dnsAddressValid(lines[index].trim())) return `自定义 DNS 第 ${index + 1} 行地址格式无效；支持 HTTP(S)、UDP、TCP、TLS 或 IP 地址`;
  }
  return '';
}
