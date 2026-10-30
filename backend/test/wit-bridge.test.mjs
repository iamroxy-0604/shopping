import test from 'node:test';
import assert from 'node:assert/strict';
import { chatViaWit, isWitEnabled, messageLink } from '../src/wit-bridge.mjs';
import { messageLinks, planLinkDesigns, resolveMessageLinks } from '../src/link-presentation.mjs';

test('Wit 桥接保持现有对话请求和响应契约', async () => {
  const env = { WIT_AGENT_URL: 'http://127.0.0.1:8765' };
  assert.equal(isWitEnabled(env), true);
  const result = await chatViaWit({ sessionId: 's1', userId: 'u1', message: '随便逛逛', env, fetchImpl: async (url, options) => {
    assert.equal(url.pathname, '/internal/wit/chat');
    assert.deepEqual(JSON.parse(options.body), { sessionId: 's1', userId: 'u1', message: '随便逛逛' });
    return { ok: true, json: async () => ({ ok: true, type: 'question', message: '先看看桌面灵感？', items: [] }) };
  } });
  assert.equal(result.message, '先看看桌面灵感？');
});

test('外部链接先由转接器解析，再作为内容证据进入 Wit', async () => {
  const url = 'https://www.example.com/story';
  assert.equal(messageLink(`参考 ${url} 好吗？`), url);
  const record = { id: 'link:1', source: { url, platform: 'example.com' }, title: '一篇文章', status: 'complete' };
  let received;
  const result = await chatViaWit({ sessionId: 's', userId: 'u', message: `看看 ${url}`, env: { WIT_AGENT_URL: 'http://127.0.0.1:8765' },
    resolveImpl: async (input) => { assert.equal(input, url); return { ok: true, record }; },
    fetchImpl: async (_url, options) => { received = JSON.parse(options.body); return { ok: true, json: async () => ({ ok: true, type: 'link_content' }) }; } });
  assert.equal(result.type, 'link_content');
  assert.equal(received.linkRecord.source.url, record.source.url);
  assert.equal(received.linkRecord.presentation.protocol, 'v0.9.1');
  assert.equal(received.linkRecord.presentation.layout, 'article');
  assert.equal((await chatViaWit({ message: 'http://localhost/admin', env: { WIT_AGENT_URL: 'http://127.0.0.1:8765' }, fetchImpl: async () => { throw new Error('should not reach Wit'); } })).error.code, 'INVALID_LINK');
});

test('多平台链接分别生成 A2UI 界面，商品链接不进入内容弹窗', async () => {
  const urls = ['https://www.bilibili.com/video/BV1234567890', 'https://example.com/post', 'https://item.taobao.com/item.htm?id=123'];
  assert.deepEqual(messageLinks(urls.join(' ')), urls);
  const records = [
    { contentType: 'video', title: '视频', video: 'https://cdn.example.com/demo.mp4', source: { url: urls[0], platform: 'B站' } },
    { contentType: 'article', title: '文章', body: '正文', source: { url: urls[1], platform: 'example.com' } },
    { contentType: 'article', title: '商品页', source: { url: urls[2], platform: '淘宝' } }
  ];
  const result = await resolveMessageLinks(urls.join(' '), {
    resolveImpl: async (url) => ({ ok: true, record: { id: `link:${urls.indexOf(url)}`, status: 'complete', ...records[urls.indexOf(url)] } }),
    planner: async () => [{ layout: 'video', source: 'ai' }, { layout: 'article', source: 'ai' }]
  });
  assert.equal(result.records.length, 3);
  assert.equal(result.records[0].presentation.layout, 'video');
  assert.equal(result.records[0].presentation.designSource, 'ai');
  assert.equal(result.records[1].presentation.layout, 'article');
  assert.equal(result.records[2].linkCategory, 'product');
  assert.equal(result.records[2].presentation, undefined);
});

test('AI 布局只接受与实际媒体匹配的受控选择', async () => {
  const records = [{ contentType: 'article', title: '文字', body: '内容', source: { url: 'https://example.com/a' } },
    { contentType: 'image', title: '图片', cover: 'https://example.com/p.jpg', source: { url: 'https://example.com/b' } }];
  const layouts = await planLinkDesigns(records, '帮我看看', { env: { LLM_BASE_URL: 'https://model.example/v1', LLM_API_KEY: 'test', LLM_MODEL: 'test' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"layouts":["video","image"]}' } }] }) }) });
  assert.deepEqual(layouts, [{ layout: 'article', source: 'rule' }, { layout: 'image', source: 'ai' }]);
});

test('Wit 桥接拒绝非本机地址，且明确报告服务不可用', async () => {
  const invalid = await chatViaWit({ message: 'x', env: { WIT_AGENT_URL: 'https://example.com' } });
  assert.equal(invalid.error.code, 'WIT_CONFIG_ERROR');
  const unavailable = await chatViaWit({ message: 'x', env: { WIT_AGENT_URL: 'http://localhost:8765' }, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(unavailable.error.code, 'WIT_UNAVAILABLE');
});

test('Wit 桥接把问卷答案连同会话标识转发', async () => {
  const answer = { questionId: 'budget', value: '500 元以内' };
  const result = await chatViaWit({
    sessionId: 'same-session', userId: 'same-user', message: answer.value, answer,
    env: { WIT_AGENT_URL: 'http://127.0.0.1:8765' },
    fetchImpl: async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body), {
        sessionId: 'same-session', userId: 'same-user', message: answer.value, answer
      });
      return { ok: true, json: async () => ({ ok: true, type: 'results', items: [] }) };
    }
  });
  assert.equal(result.type, 'results');
});
