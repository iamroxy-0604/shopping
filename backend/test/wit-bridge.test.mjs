import test from 'node:test';
import assert from 'node:assert/strict';
import { chatViaWit, isWitEnabled } from '../src/wit-bridge.mjs';

test('Wit 桥接保持现有对话请求和响应契约', async () => {
  const env = { WIT_AGENT_URL: 'http://127.0.0.1:8765' };
  assert.equal(isWitEnabled(env), true);
  const result = await chatViaWit({ sessionId: 's1', message: '随便逛逛', env, fetchImpl: async (url, options) => {
    assert.equal(url.pathname, '/internal/wit/chat');
    assert.deepEqual(JSON.parse(options.body), { sessionId: 's1', message: '随便逛逛' });
    return { ok: true, json: async () => ({ ok: true, type: 'question', message: '先看看桌面灵感？', items: [] }) };
  } });
  assert.equal(result.message, '先看看桌面灵感？');
});

test('Wit 桥接拒绝非本机地址，且明确报告服务不可用', async () => {
  const invalid = await chatViaWit({ message: 'x', env: { WIT_AGENT_URL: 'https://example.com' } });
  assert.equal(invalid.error.code, 'WIT_CONFIG_ERROR');
  const unavailable = await chatViaWit({ message: 'x', env: { WIT_AGENT_URL: 'http://localhost:8765' }, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(unavailable.error.code, 'WIT_UNAVAILABLE');
});
