import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLink } from './resolver.mjs';
import { composeA2ui } from './a2ui.mjs';
import { composeReactA2ui } from './react-a2ui.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function body(req) {
  let value = '';
  for await (const chunk of req) {
    value += chunk;
    if (value.length > 10000) throw new Error('request_too_large');
  }
  return JSON.parse(value);
}

export function createServer({ resolve = resolveLink } = {}) {
  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true, service: 'link-bridge' });
    if (req.method === 'POST' && req.url === '/api/resolve') {
      try {
        const request = await body(req);
        const result = await resolve(request?.url);
        return json(res, result.ok ? 200 : 400, result);
      } catch {
        return json(res, 400, { ok: false, code: 'bad_request', message: '链接请求格式不正确。' });
      }
    }
    if (req.method === 'POST' && req.url === '/api/compose') {
      try {
        const request = await body(req);
        const result = composeA2ui(request?.record, request?.mode);
        return json(res, result.ok ? 200 : 400, result);
      } catch {
        return json(res, 400, { ok: false, code: 'bad_request', message: '界面编排请求格式不正确。' });
      }
    }
    if (req.method === 'POST' && req.url === '/api/react-compose') {
      try {
        const request = await body(req);
        const result = composeReactA2ui(request?.record, request?.mode);
        return json(res, result.ok ? 200 : 400, result);
      } catch {
        return json(res, 400, { ok: false, code: 'bad_request', message: 'React A2UI 编排请求格式不正确。' });
      }
    }
    if (req.method === 'GET') {
      const name = req.url === '/' ? 'index.html' : req.url?.slice(1);
      if (typeof name === 'string' && /^(?:index\.html|app\.js|styles\.css|a2ui\.html|a2ui\.bundle\.js|a2ui\.css)$/.test(name)) {
        const file = path.join(root, name);
        res.writeHead(200, { 'content-type': types[path.extname(file)], 'cache-control': 'no-store' });
        return fs.createReadStream(file).pipe(res);
      }
    }
    return json(res, 404, { ok: false, code: 'not_found' });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3100);
  createServer().listen(port, '127.0.0.1', () => console.log(`Link Bridge: http://127.0.0.1:${port}`));
}
