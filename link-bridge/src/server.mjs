import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLink } from './resolver.mjs';
import { composeA2ui } from './a2ui.mjs';
import { composeReactA2ui } from './react-a2ui.mjs';
import { planDetailComponent, plannerConfigured } from './llm-planner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const moduleRoot = path.resolve(root, '..');
try { process.loadEnvFile(path.join(moduleRoot, '.env')); } catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

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

export function createServer({ resolve = resolveLink, plan = planDetailComponent } = {}) {
  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true, service: 'link-bridge', planner: { configured: plannerConfigured() } });
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
        const baseResult = composeReactA2ui(request?.record, request?.mode);
        if (!baseResult.ok) return json(res, 400, baseResult);
        let planner = { used: false, source: 'rules', reason: request?.mode === 'preview' ? '预览使用稳定的通用卡片组件。' : 'LLM Planner 未启用。' };
        let selectedPlan = null;
        if (request?.mode === 'detail' && request?.usePlanner !== false) {
          try {
            selectedPlan = await plan(request?.record);
            planner = { used: true, source: 'llm', ...selectedPlan };
          } catch (error) {
            planner = { used: false, source: 'rules', fallback: true, reason: '规则回退：LLM Planner 当前不可用。', error: error?.message || 'planner_failed' };
          }
        }
        const result = selectedPlan ? composeReactA2ui(request?.record, request?.mode, selectedPlan) : baseResult;
        if (result.ok) result.planner = planner;
        return json(res, result.ok ? 200 : 400, result);
      } catch {
        return json(res, 400, { ok: false, code: 'bad_request', message: 'React A2UI 编排请求格式不正确。' });
      }
    }
    if (req.method === 'GET') {
      const name = req.url === '/' ? 'index.html' : req.url?.slice(1);
      if (typeof name === 'string' && (/^(?:index\.html|app\.js|styles\.css|a2ui\.html|a2ui\.bundle\.js|a2ui\.css)$/.test(name) || /^assets\/themes\/(?:western|journal)\/[a-z-]+\.svg$/.test(name))) {
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
