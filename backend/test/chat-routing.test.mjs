import test from 'node:test';
import assert from 'node:assert/strict';
import { isStructuredChatRequest } from '../src/chat-routing.mjs';

test('流式路由只把防晒或结构化回答交给结构化 Agent', () => {
  assert.equal(isStructuredChatRequest({ message: '帮我找军训防晒霜' }), true);
  assert.equal(isStructuredChatRequest({ message: '油皮', answer: { questionId: 'skinType', value: '油皮' } }), true);
  assert.equal(isStructuredChatRequest({ message: '帮我推荐一款耳机' }), false);
  assert.equal(isStructuredChatRequest({ message: '更在意清爽不黏' }), false);
  assert.equal(isStructuredChatRequest({ message: '我想买一个笔袋', hasSunscreenTask: true }), false);
});
