import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseShoppingQuery } from './query.mjs';
import { searchProductSource } from './product-source.mjs';
import { chat, chatStructured } from './agent.mjs';
import { logEvent } from './logger.mjs';
import { chatViaWit, isWitEnabled } from './wit-bridge.mjs';
import { isStructuredChatRequest } from './chat-routing.mjs';
import { discoverRelatedContent, mediaRoot } from './content/index.mjs';

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

function sendSseHeaders(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type'
  });
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function emitWitProgress(res, resultPromise) {
  writeSse(res, 'phase', { id: 'understand', label: '需求分析', status: 'running' });
  const started = Date.now();
  const result = await resultPromise;
  await wait(Math.max(0, 700 - (Date.now() - started)));
  writeSse(res, 'phase', { id: 'understand', label: '需求分析', status: 'completed' });
  if (result.type === 'question' && result.question) {
    writeSse(res, 'phase', { id: 'clarify', label: '补充问卷', status: 'running' });
  } else if (result.type === 'results') {
    for (const [id, label] of [['clarify', '补充问卷'], ['search', '搜索商品'], ['rank', '筛选整理']]) {
      writeSse(res, 'phase', { id, label, status: 'completed' });
    }
  }
  return result;
}

function serveStatic(res, url) {
  const relative = url === '/' ? 'index.html' : url.slice(1);
  if (!/^[a-zA-Z0-9._/-]+$/.test(relative) || relative.includes('..')) return false;
  const filePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public', relative);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
  res.writeHead(200, { 'content-type': types[path.extname(filePath)] || 'application/octet-stream', 'cache-control': 'no-store' });
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
  if (req.method === 'GET' && req.url === '/health') return sendJson(res, 200, { ok: true, service: 'taobao-search', agentRuntime: isWitEnabled() ? 'wit3' : 'legacy' });
  if (req.method === 'GET' && req.url?.startsWith('/api/content/media/')) {
    const match = req.url.match(/^\/api\/content\/media\/([a-zA-Z0-9]+)\/([a-zA-Z0-9]+_[1-9][0-9]*\.(?:jpg|png|webp|mp4))$/);
    if (!match || !match[2].startsWith(`${match[1]}_`)) return sendJson(res, 404, { ok: false });
    const file = path.join(mediaRoot, match[1], match[2]);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return sendJson(res, 404, { ok: false });
    const mediaType = match[2].endsWith('.mp4') ? 'video/mp4' : match[2].endsWith('.webp') ? 'image/webp' : match[2].endsWith('.png') ? 'image/png' : 'image/jpeg';
    res.writeHead(200, { 'content-type': mediaType, 'cache-control': 'private, max-age=3600' });
    fs.createReadStream(file).pipe(res);
    return;
  }
  if (req.method === 'GET' && serveStatic(res, req.url)) return;
  if (req.method === 'POST' && req.url === '/internal/content/discover') {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress))
      return sendJson(res, 403, { ok: false, error: { code: 'LOCAL_ONLY' } });
    if (req.headers.origin && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(req.headers.origin))
      return sendJson(res, 403, { ok: false, error: { code: 'LOCAL_ONLY' } });
    try {
      const task = JSON.parse(await readBody(req) || '{}');
      if (!task || typeof task !== 'object' || Array.isArray(task) || typeof task.category !== 'string' || task.category.length > 80)
        return sendJson(res, 400, { ok: false, error: { code: 'INVALID_TASK' } });
      return sendJson(res, 200, { ok: true, ...(await discoverRelatedContent(task)) });
    } catch {
      return sendJson(res, 400, { ok: false, error: { code: 'INVALID_TASK' } });
    }
  }
  if (req.method === 'POST' && req.url === '/api/chat') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const structured = !isWitEnabled() && isStructuredChatRequest(body);
      const result = structured
        ? await chatStructured({ sessionId: body.sessionId, userId: body.userId, message: body.message, answer: body.answer })
        : isWitEnabled()
        ? await chatViaWit({ sessionId: body.sessionId, userId: body.userId, message: body.message, answer: body.answer, recordId: body.recordId })
        : await chat({ sessionId: body.sessionId, message: body.message });
      return sendJson(res, result.ok ? 200 : 502, result);
    } catch {
      return sendJson(res, 400, { ok: false, error: { code: 'INVALID_JSON', message: '请求体需要是合法 JSON' } });
    }
  }
  if (req.method === 'POST' && req.url === '/api/chat/stream') {
    let body;
    try {
      body = JSON.parse(await readBody(req) || '{}');
    } catch {
      return sendJson(res, 400, { ok: false, error: { code: 'INVALID_JSON', message: '请求体需要是合法 JSON' } });
    }
    sendSseHeaders(res);
    try {
      const structured = !isWitEnabled() && isStructuredChatRequest(body);
      const result = structured
        ? await chatStructured({
          sessionId: body.sessionId,
          userId: body.userId,
          message: body.message,
          answer: body.answer,
          onPhase: async (phase) => writeSse(res, 'phase', phase)
        })
        : isWitEnabled()
          ? await emitWitProgress(res, chatViaWit({ sessionId: body.sessionId, userId: body.userId, message: body.message, answer: body.answer, recordId: body.recordId }))
          : await chat({ sessionId: body.sessionId, message: body.message });
      writeSse(res, result.ok ? 'result' : 'error', result);
      writeSse(res, 'done', { ok: result.ok });
    } catch (error) {
      writeSse(res, 'error', { ok: false, error: { code: 'CHAT_FAILED', message: '导购服务暂时不可用，请稍后再试' } });
      writeSse(res, 'done', { ok: false });
    }
    return res.end();
  }
  if (req.method !== 'POST' || req.url !== '/api/products/search') return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '接口不存在' } });
  try {
    const body = JSON.parse(await readBody(req) || '{}');
    const parsed = parseShoppingQuery(body.query);
    const result = await searchProductSource({ query: parsed.query, filters: { ...parsed.filters, ...(body.filters || {}) }, source: body.source });
    if (!result.ok) return sendJson(res, result.error.code === 'INVALID_QUERY' ? 400 : 502, result);
    return sendJson(res, 200, { ok: true, query: parsed, items: result.items });
  } catch (error) {
    return sendJson(res, 400, { ok: false, error: { code: 'INVALID_JSON', message: '请求体需要是合法 JSON' } });
  }
});

server.listen(port, () => {
  logEvent('server_started', { port });
  console.log(`Shopping backend listening on http://localhost:${port}`);
});
