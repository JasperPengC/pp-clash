import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { createWriteStream, mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect } from 'vitest';

export async function startTestSubStore(evidence: string) {
  mkdirSync(evidence, { recursive: true });
  const data = mkdtempSync(`${resolve(evidence)}/engine-`);
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port; await new Promise<void>(done => reservation.close(() => done()));
  const child = spawn(process.execPath, [resolve('src-tauri/resources/sub-store/sub-store.bundle.cjs')], { cwd: data, env: { ...process.env, SUB_STORE_DATA_BASE_PATH: data, SUB_STORE_BACKEND_API_HOST: '127.0.0.1', SUB_STORE_BACKEND_API_PORT: String(port), SUB_STORE_FRONTEND_BACKEND_PATH: '/' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(`${data}/server.log`); child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  async function close() {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 3000); await exited; clearTimeout(timer); }
    log.end();
  }
  const http = (route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => new Promise<{ status: number; text: string }>((done, fail) => {
    const request = httpRequest(`http://127.0.0.1:${port}${route}`, { method, headers: { 'Content-Type': 'application/json' } }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; }); response.on('end', () => done({ status: response.statusCode ?? 0, text })); response.on('error', fail);
    });
    request.on('error', fail); request.setTimeout(5000, () => request.destroy(new Error('引擎请求超时'))); request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null) throw new Error(`引擎启动失败 ${child.exitCode}`);
      try { ready = (await http('/api/subs')).status === 200; } catch { /* 服务启动中 */ }
      if (ready) break; await new Promise(done => setTimeout(done, 100));
    }
    expect(ready).toBe(true);
  } catch (error) { await close(); throw error; }
  return {
    data, http, close,
    call: async (route: string, body?: unknown, method?: string, status = 200) => {
      const result = await http(route, body, method); expect(result.status, result.text).toBe(status);
      const json = JSON.parse(result.text); expect(json.status).toBe('success'); return json.data;
    },
    serveText: async (text: string) => {
      const server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/yaml' }); response.end(text); });
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/config.yaml`, close: () => new Promise<void>(done => server.close(() => done())) };
    },
  };
}
