import test from 'node:test';
import assert from 'node:assert/strict';
import { planDetailComponent, plannerConfigured } from '../src/llm-planner.mjs';

const env = {
  LLM_BASE_URL: 'https://gateway.example/v1',
  LLM_API_KEY: 'test-key',
  LLM_MODEL: 'test-model',
  LLM_TIMEOUT_MS: '5000',
};

const record = {
  source: { platform: 'B站', url: 'https://www.bilibili.com/video/BV1' },
  contentType: 'video',
  title: '16 款充电宝横评',
  description: '比较快充、发热和重量。',
  cover: 'https://example.com/cover.jpg',
};

test('planner configuration requires endpoint, key and model', () => {
  assert.equal(plannerConfigured(env), true);
  assert.equal(plannerConfigured({ ...env, LLM_API_KEY: '' }), false);
});

test('LLM planner sends the registered catalog choices and accepts a valid plan', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: '{"component":"VideoExperienceDetail","reason":"这是横向测试视频，应优先展示视频封面和摘要。","confidence":0.96}' } }] };
      },
    };
  };
  const result = await planDetailComponent(record, { fetchImpl, env });
  assert.equal(result.component, 'VideoExperienceDetail');
  assert.equal(result.model, 'test-model');
  assert.equal(request.url, 'https://gateway.example/v1/chat/completions');
  assert.equal(request.options.headers.authorization, 'Bearer test-key');
  const payload = JSON.parse(request.options.body);
  assert.match(payload.messages[1].content, /ArticleExperienceDetail/);
  assert.equal(payload.messages[1].content.includes('test-key'), false);
});

test('LLM planner rejects invented components', async () => {
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return { choices: [{ message: { content: '{"component":"FancyUnknownCard","reason":"invented","confidence":1}' } }] };
    },
  });
  await assert.rejects(() => planDetailComponent(record, { fetchImpl, env }), /planner_invalid_component/);
});

