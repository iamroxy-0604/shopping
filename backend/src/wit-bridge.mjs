import { resolveLink } from '../../link-bridge/src/resolver.mjs';
import { messageLinks, resolveMessageLinks, planLinkDesigns } from './link-presentation.mjs';
const DEFAULT_TIMEOUT_MS = 330000;

export function messageLink(message) {
  return messageLinks(message)[0] || '';
}

function hasWebLink(message) { return typeof message === 'string' && /https?:\/\/\S+/i.test(message); }

export function isWitEnabled(env = process.env) {
  return Boolean(env.WIT_AGENT_URL);
}

export async function chatViaWit({ sessionId, userId, message, answer, recordId, env = process.env, fetchImpl = fetch, resolveImpl = resolveLink, planImpl = planLinkDesigns, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const configuredUrl = String(env.WIT_AGENT_URL || '').trim();
  let endpoint;
  try {
    const base = new URL(configuredUrl);
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(base.hostname) || base.protocol !== 'http:') throw new Error('local only');
    endpoint = new URL('/internal/wit/chat', base);
  } catch {
    return { ok: false, type: 'error', items: [], error: { code: 'WIT_CONFIG_ERROR', message: 'Wit 服务地址必须是本机 HTTP 地址' } };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const links = messageLinks(message);
    if (!links.length && hasWebLink(message)) return { ok: false, type: 'error', items: [], error: { code: 'INVALID_LINK', message: '链接必须是公开的 HTTP 或 HTTPS 地址。' } };
    const resolved = links.length ? await resolveMessageLinks(message, { resolveImpl, planner: planImpl, env }) : { records: [], errors: [] };
    if (links.length && !resolved.records.length) return { ok: false, type: 'error', items: [], error: { code: 'LINK_READ_FAILED', message: resolved.errors[0] || '链接暂时无法读取。' } };
    const linkRecords = resolved.records;
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, userId, message, answer, recordId, ...(linkRecords.length === 1 ? { linkRecord: linkRecords[0] } : linkRecords.length ? { linkRecords } : {}) }),
      signal: controller.signal
    });
    const payload = await response.json();
    if (!response.ok || !payload || typeof payload !== 'object' || typeof payload.ok !== 'boolean') {
      return { ok: false, type: 'error', items: [], error: { code: 'WIT_BAD_RESPONSE', message: 'Wit 服务返回异常，请稍后重试' } };
    }
    return payload;
  } catch (error) {
    return { ok: false, type: 'error', items: [], error: { code: error.name === 'AbortError' ? 'WIT_TIMEOUT' : 'WIT_UNAVAILABLE', message: error.name === 'AbortError' ? '导购响应超时，请稍后重试' : '暂时无法连接导购服务，请检查 Wit 服务是否已启动' } };
  } finally {
    clearTimeout(timer);
  }
}
