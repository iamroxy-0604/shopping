import test from 'node:test';
import assert from 'node:assert/strict';
import { searchOpenFoodFactsSample, searchProductSource } from '../src/product-source.mjs';

test('开源样本可按食品词检索，价格未知不会变成零元优惠', () => {
  const result = searchOpenFoodFactsSample({ query: '我想看看巧克力' });
  assert.equal(result.ok, true);
  assert.ok(result.items.some((item) => /Nutella/i.test(item.title)));
  assert.ok(result.items.every((item) => item.price === null && item.promotionUrl === ''));
  assert.ok(result.items.every((item) => item.source.url && item.media.images.length));
});

test('商品源可切换，未指定时保留淘宝默认链路', async () => {
  const open = await searchProductSource({ query: '可乐', source: 'open-food-facts-sample' });
  assert.ok(open.items.some((item) => /Coca-Cola/i.test(item.title)));
  const taobao = await searchProductSource({ query: '餐桌', env: {}, searchTaobaoImpl: async ({ query }) => ({ ok: true, items: [{ id: query }] }) });
  assert.deepEqual(taobao.items, [{ id: 'taobao:餐桌', source: 'taobao' }]);
});

test('淘宝和悦买并行查询后交错合并，避免单一来源挤占候选', async () => {
  const result = await searchProductSource({
    query: '充电宝',
    env: { SHOPPING_PRODUCT_SOURCES: 'taobao,yuemai' },
    searchTaobaoImpl: async () => ({ ok: true, items: [{ id: 't1', title: '淘宝一' }, { id: 't2', title: '淘宝二' }] }),
    searchYuemaiImpl: async () => ({ ok: true, items: [{ id: 'yuemai:y1', title: '悦买一', source: 'yuemai' }, { id: 'yuemai:y2', title: '悦买二', source: 'yuemai' }] })
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'multi');
  assert.deepEqual(result.items.map((item) => item.id), ['taobao:t1', 'yuemai:y1', 'taobao:t2', 'yuemai:y2']);
  assert.deepEqual(result.sources.map((entry) => [entry.source, entry.ok, entry.count]), [['taobao', true, 2], ['yuemai', true, 2]]);
});

test('一个商品源失败时保留另一个来源并返回可诊断告警', async () => {
  const result = await searchProductSource({
    query: '台灯',
    source: 'taobao,yuemai',
    searchTaobaoImpl: async () => ({ ok: false, error: { code: 'TIMEOUT', message: '淘宝超时' } }),
    searchYuemaiImpl: async () => ({ ok: true, items: [{ id: 'yuemai:1', title: '悦买台灯', source: 'yuemai' }] })
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.items.map((item) => item.id), ['yuemai:1']);
  assert.deepEqual(result.warnings, [{ source: 'taobao', code: 'TIMEOUT', message: '淘宝超时' }]);
});

test('所有商品源失败和未知来源会返回稳定错误', async () => {
  const failed = await searchProductSource({
    query: '台灯',
    source: ['taobao', 'yuemai'],
    searchTaobaoImpl: async () => ({ ok: false, error: { code: 'TIMEOUT', message: '淘宝超时' } }),
    searchYuemaiImpl: async () => ({ ok: false, error: { code: 'NETWORK_ERROR', message: '悦买不可用' } })
  });
  assert.equal(failed.error.code, 'ALL_SOURCES_FAILED');
  assert.equal(failed.items.length, 0);
  const invalid = await searchProductSource({ query: '台灯', source: 'unknown' });
  assert.equal(invalid.error.code, 'INVALID_SOURCE');
});
