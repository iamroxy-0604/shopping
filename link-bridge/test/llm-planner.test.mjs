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
        return { choices: [{ message: { content: '{"planVersion":"1","reason":"先看视频和摘要","confidence":0.96,"content":{"displayTitle":"16款充电宝实测","displaySummary":"内容比较了快充、发热和重量。","showCover":true},"sections":[{"id":"source","component":"SourceHeader","variant":"default"},{"id":"hero","component":"HeroMedia","variant":"poster"},{"id":"summary","component":"ContentSummary","variant":"default"},{"id":"actions","component":"SourceActions","variant":"default"}]}' } }] };
      },
    };
  };
  const result = await planDetailComponent(record, { fetchImpl, env });
  assert.equal(result.sections[1].component, 'HeroMedia');
  assert.equal(result.model, 'test-model');
  assert.equal(result.content.displayTitle, '16款充电宝实测');
  assert.equal(result.content.showCover, true);
  assert.equal(request.url, 'https://gateway.example/v1/chat/completions');
  assert.equal(request.options.headers.authorization, 'Bearer test-key');
  const payload = JSON.parse(request.options.body);
  assert.match(payload.messages[1].content, /ProductComparison/);
  assert.equal(payload.messages[1].content.includes('test-key'), false);
});

test('LLM planner rejects invented components', async () => {
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return { choices: [{ message: { content: '{"planVersion":"1","sections":[{"id":"unknown","component":"FancyUnknownCard","variant":"default"},{"id":"actions","component":"SourceActions","variant":"default"}]}' } }] };
    },
  });
  await assert.rejects(() => planDetailComponent(record, { fetchImpl, env }), /planner_invalid_component/);
});

