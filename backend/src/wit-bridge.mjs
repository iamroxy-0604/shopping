const DEFAULT_TIMEOUT_MS = 45000;

export function isWitEnabled(env = process.env) {
  return Boolean(env.WIT_AGENT_URL);
}

export async function chatViaWit({ sessionId, userId, message, env = process.env, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
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
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, userId, message }),
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
