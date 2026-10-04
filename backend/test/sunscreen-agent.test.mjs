import test from 'node:test';
import assert from 'node:assert/strict';
import { chatStructured, hasSunscreenTask, resetSession } from '../src/agent.mjs';

test('防晒任务按同一会话动态追问肤质和预算，再用条件筛选真实商品', async () => {
  const sessionId = 'sunscreen-flow-test';
  resetSession(sessionId);
  const calls = [];
  const search = async ({ query, filters }) => {
    calls.push({ query, filters });
    return { ok: true, items: [
      { id: 's-0', title: '平价防晒霜', price: 40, source: 'taobao', promotionUrl: 'https://example.test/s-0' },
      { id: 's-1', title: '清透防晒霜 SPF50+', price: 69, source: 'taobao', promotionUrl: 'https://example.test/s-1' },
      { id: 's-2', title: '户外防晒乳', price: 129, source: 'taobao', promotionUrl: 'https://example.test/s-2' },
      { id: 'other', title: '军训遮阳帽', price: 29, source: 'taobao', promotionUrl: 'https://example.test/other' }
    ] };
  };
  const first = await chatStructured({ sessionId, message: '帮我推荐一款适合军训的防晒霜', search });
  assert.equal(first.type, 'question');
  assert.equal(first.question.id, 'skinType');
  const second = await chatStructured({ sessionId, message: '油皮', answer: { questionId: 'skinType', value: '油皮' }, search });
  assert.equal(second.question.id, 'budget');
  const result = await chatStructured({ sessionId, message: '50-100元', answer: { questionId: 'budget', value: '50-100元' }, search });
  assert.equal(result.type, 'results');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, 's-1');
  assert.equal(calls[0].query, '防晒霜 军训');
  assert.equal(calls[0].filters.start_price, 50);
  assert.equal(calls[0].filters.end_price, 100);
  assert.match(result.message, /实际表现请再查看/);
  assert.doesNotMatch(result.items[0].recommendation, /结合油皮筛选/);
  assert.match(result.items[0].recommendation, /成分、评价或商品详情/);
  assert.match(result.summary, /油皮偏好/);
  assert.ok(Array.isArray(result.followups));
  resetSession(sessionId);
});

test('已给出的肤质和预算会跳过追问，并产生真实阶段事件', async () => {
  const sessionId = 'sunscreen-skip-test';
  resetSession(sessionId);
  const phases = [];
  const result = await chatStructured({
    sessionId,
    message: '油皮，预算100元以内，帮我找军训防晒霜',
    search: async () => ({ ok: true, items: [{ id: 's-3', title: '防晒霜', price: 80 }] }),
    onPhase: async (phase) => phases.push(`${phase.id}:${phase.status}`)
  });
  assert.equal(result.type, 'results');
  assert.deepEqual(phases, [
    'understand:running', 'understand:completed',
    'clarify:completed', 'search:running', 'search:completed',
    'rank:running', 'rank:completed'
  ]);
  resetSession(sessionId);
});

test('无预算前缀也能识别金额，换预算会清除旧条件并重新追问', async () => {
  const sessionId = 'sunscreen-budget-change-test';
  resetSession(sessionId);
  const search = async ({ filters }) => ({ ok: true, items: [{ id: 's-4', title: '防晒霜', price: filters.end_price || 180 }] });
  const initial = await chatStructured({ sessionId, message: '油皮，100元以内的军训防晒霜', search });
  assert.equal(initial.type, 'results');
  assert.equal(hasSunscreenTask(sessionId), true);
  assert.equal(initial.task.answers.budget.max, 100);
  const question = await chatStructured({ sessionId, message: '换一个预算范围', search });
  assert.equal(question.type, 'question');
  assert.equal(question.question.id, 'budget');
  const changed = await chatStructured({ sessionId, message: '200元以内', answer: { questionId: 'budget', value: '200元以内' }, search });
  assert.equal(changed.type, 'results');
  assert.equal(changed.task.answers.budget.max, 200);
  resetSession(sessionId);
});

test('问卷尚未完成时不会发出补充问卷 completed 事件，零结果文案不伪装成有商品', async () => {
  const sessionId = 'sunscreen-empty-test';
  resetSession(sessionId);
  const phases = [];
  const question = await chatStructured({
    sessionId,
    message: '适合军训的防晒霜',
    search: async () => ({ ok: true, items: [] }),
    onPhase: async (phase) => phases.push(`${phase.id}:${phase.status}`)
  });
  assert.equal(question.type, 'question');
  assert.deepEqual(phases, ['understand:running', 'understand:completed', 'clarify:running']);
  const result = await chatStructured({
    sessionId,
    message: '油皮',
    answer: { questionId: 'skinType', value: '油皮' },
    search: async () => ({ ok: true, items: [] })
  });
  assert.equal(result.type, 'question');
  const complete = await chatStructured({
    sessionId,
    message: '100元以内',
    answer: { questionId: 'budget', value: '100元以内' },
    search: async () => ({ ok: true, items: [] })
  });
  assert.equal(complete.type, 'results');
  assert.match(complete.message, /没有返回符合条件的真实防晒霜/);
  resetSession(sessionId);
});

test('结果 followup 会保存使用偏好、改变搜索词并按标题相关性排序', async () => {
  const sessionId = 'sunscreen-preference-followup-test';
  resetSession(sessionId);
  const calls = [];
  const search = async ({ query }) => {
    calls.push(query);
    return { ok: true, items: [
      { id: 'generic', title: '高倍防晒霜', price: 60 },
      { id: 'fresh', title: '清爽不黏防晒乳', price: 60 }
    ] };
  };
  const initial = await chatStructured({ sessionId, message: '油皮，100元以内的军训防晒霜', search });
  assert.equal(initial.type, 'results');
  const followup = await chatStructured({ sessionId, message: '更在意清爽不黏', search });
  assert.equal(followup.type, 'results');
  assert.equal(followup.task.answers.preference.label, '清爽不黏');
  assert.match(calls[1], /防晒霜 军训 清爽不黏/);
  assert.equal(followup.items[0].id, 'fresh');
  assert.match(followup.items[0].recommendation, /标题包含“清爽不黏”/);
  assert.doesNotMatch(followup.items[0].recommendation, /保证|适合油皮|防水耐汗功效/);
  resetSession(sessionId);
});

test('偏好词召回为空时退回基础防晒查询，并保持结果阶段契约', async () => {
  const sessionId = 'sunscreen-preference-fallback-test';
  resetSession(sessionId);
  const calls = [];
  const phases = [];
  const search = async ({ query }) => {
    calls.push(query);
    if (query.includes('清爽不黏')) return { ok: true, items: [] };
    return { ok: true, items: [{ id: 'base', title: '防晒霜 SPF50+', price: 80 }] };
  };
  await chatStructured({ sessionId, message: '油皮，100元以内的军训防晒霜', search });
  const result = await chatStructured({
    sessionId,
    message: '更在意清爽不黏',
    search,
    onPhase: async (phase) => phases.push(`${phase.id}:${phase.status}`)
  });
  assert.equal(result.type, 'results');
  assert.deepEqual(calls.slice(-2), ['防晒霜 军训 清爽不黏', '防晒霜 军训']);
  assert.deepEqual(phases, [
    'understand:running', 'understand:completed', 'clarify:completed',
    'search:running', 'search:completed', 'rank:running', 'rank:completed'
  ]);
  assert.match(result.items[0].recommendation, /标题未明确包含“清爽不黏”/);
  resetSession(sessionId);
});
