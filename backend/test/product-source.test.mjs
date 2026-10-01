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
  assert.deepEqual(taobao.items, [{ id: '餐桌' }]);
});
