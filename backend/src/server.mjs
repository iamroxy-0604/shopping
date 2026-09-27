import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseShoppingQuery } from './query.mjs';
import { searchTaobao } from './taobao.mjs';
import { chat } from './agent.mjs';

loadDotEnv();
const port = Number(process.env.PORT || 3000);

function loadDotEnv() {
  const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' });
  res.end(JSON.stringify(data));
}

function serveStatic(res, url) {
  const relative = url === '/' ? 'index.html' : url.slice(1);
  if (!/^[a-zA-Z0-9._/-]+$/.test(relative) || relative.includes('..')) return false;
  const filePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public', relative);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
  res.writeHead(200, { 'content-type': types[path.extname(filePath)] || 'application/octet-stream' });
  res.end(fs.readFileSync(filePath));
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 100_000) reject(new Error('body too large')); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  if (req.method === 'GET' && req.url === '/health') return sendJson(res, 200, { ok: true, service: 'taobao-search' });
  if (req.method === 'GET' && serveStatic(res, req.url)) return;
  if (req.method === 'POST' && req.url === '/api/chat') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const result = await chat({ sessionId: body.sessionId, message: body.message });
      return sendJson(res, result.ok ? 200 : 502, result);
    } catch {
      return sendJson(res, 400, { ok: false, error: { code: 'INVALID_JSON', message: '请求体需要是合法 JSON' } });
    }
  }
  if (req.method !== 'POST' || req.url !== '/api/products/search') return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '接口不存在' } });
  try {
    const body = JSON.parse(await readBody(req) || '{}');
    const parsed = parseShoppingQuery(body.query);
    const result = await searchTaobao({ query: parsed.query, filters: { ...parsed.filters, ...(body.filters || {}) } });
    if (!result.ok) return sendJson(res, result.error.code === 'INVALID_QUERY' ? 400 : 502, result);
    return sendJson(res, 200, { ok: true, query: parsed, items: result.items });
  } catch (error) {
    return sendJson(res, 400, { ok: false, error: { code: 'INVALID_JSON', message: '请求体需要是合法 JSON' } });
  }
});

server.listen(port, () => console.log(`Shopping backend listening on http://localhost:${port}`));
