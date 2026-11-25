import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';

// 合成DNS线协议fixture，只提供文档地址，无外部网络或引擎函数替换。
export async function startDnsFixture() {
  const requests: { name: string; type: number; transport: string }[] = [];
  function answer(query: Buffer, transport: string, empty = false) {
    let offset = 12; const labels: string[] = [];
    while (query[offset]) { const length = query[offset++]; labels.push(query.subarray(offset, offset + length).toString()); offset += length; }
    offset++; const type = query.readUInt16BE(offset); offset += 4;
    const name = labels.join('.'); requests.push({ name, type, transport });
    const successful = !empty && name === 'resolved.example.invalid';
    const header = Buffer.alloc(12); header.writeUInt16BE(query.readUInt16BE(0), 0); header.writeUInt16BE(0x8180, 2); header.writeUInt16BE(1, 4); header.writeUInt16BE(successful ? 1 : 0, 6);
    const question = query.subarray(12, offset);
    if (!successful) return Buffer.concat([header, question]);
    const ip = type === 28 ? Buffer.from('20010db8000000000000000000000055', 'hex') : Buffer.from([192, 0, 2, 55]);
    const record = Buffer.alloc(12); record.writeUInt16BE(0xc00c, 0); record.writeUInt16BE(type, 2); record.writeUInt16BE(1, 4); record.writeUInt32BE(60, 6); record.writeUInt16BE(ip.length, 10);
    return Buffer.concat([header, question, record, ip]);
  }
  const http = createServer((request, response) => {
    const url = new URL(request.url!, 'http://127.0.0.1'); const query = Buffer.from(url.searchParams.get('dns')!, 'base64url');
    response.writeHead(200, { 'Content-Type': 'application/dns-message' }); response.end(answer(query, 'doh', url.pathname === '/empty'));
  });
  const udp = createSocket('udp4'); udp.on('message', (query, peer) => udp.send(answer(query, 'udp'), peer.port, peer.address));
  const tcp = createTcpServer(socket => { let bytes = Buffer.alloc(0); socket.on('data', chunk => { bytes = Buffer.concat([bytes, chunk]); if (bytes.length < 2 || bytes.length < bytes.readUInt16BE(0) + 2) return; const result = answer(bytes.subarray(2, bytes.readUInt16BE(0) + 2), 'tcp'); const length = Buffer.alloc(2); length.writeUInt16BE(result.length); socket.end(Buffer.concat([length, result])); }); });
  http.listen(0, '127.0.0.1'); await once(http, 'listening'); udp.bind(0, '127.0.0.1'); await once(udp, 'listening'); tcp.listen(0, '127.0.0.1'); await once(tcp, 'listening');
  const port = (http.address() as { port: number }).port;
  return { requests, doh: `http://127.0.0.1:${port}/dns-query`, empty: `http://127.0.0.1:${port}/empty`, udp: `udp://127.0.0.1:${udp.address().port}`, tcp: `tcp://127.0.0.1:${(tcp.address() as { port: number }).port}`, close: async () => { await Promise.all([new Promise<void>(done => http.close(() => done())), new Promise<void>(done => udp.close(() => done())), new Promise<void>(done => tcp.close(() => done()))]); } };
}
