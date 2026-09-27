import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaobaoParams, normalizeTaobaoResponse, searchTaobao, signTaobaoRequest } from '../src/taobao.mjs';
import { parseShoppingQuery } from '../src/query.mjs';
import { chat, resetSession } from '../src/agent.mjs';

test('签名结果稳定且不包含 sign 本身', () => {
  const params = { app_key: '123', method: 'x', format: 'json' };
  assert.equal(signTaobaoRequest(params, 'secret', 'md5'), 'E91E6A9F37EE34B7996E59A8A199132F');
  assert.equal(signTaobaoRequest(params, 'secret', 'hmac'), 'B043DE69E112ACBA6DE4DBBE4F38DF1A');
});

test('构造必需参数和可选筛选条件', () => {
  const params = buildTaobaoParams({ appKey: 'k', adzoneId: 'z', query: '桌面灯', filters: { end_price: 100, has_coupon: 1 } });
  assert.equal(params.method, 'taobao.tbk.dg.material.optional');
  assert.equal(params.end_price, '100');
  assert.equal(params.has_coupon, '1');
  const recommendParams = buildTaobaoParams({ appKey: 'k', adzoneId: 'z', query: '灯', apiMethod: 'taobao.tbk.dg.material.recommend', materialId: 123 });
  assert.equal(recommendParams.material_id, '123');
  assert.equal(recommendParams.q, undefined);
  const upgradeParams = buildTaobaoParams({ appKey: 'k', adzoneId: 'z', query: '灯', apiMethod: 'taobao.tbk.dg.material.optional.upgrade' });
  assert.equal(upgradeParams.q, '灯');
});

test('解析中文预算并统一淘宝字段', () => {
  const parsed = parseShoppingQuery('我想找日系桌面灯，预算100元以内');
  assert.equal(parsed.filters.end_price, 100);
  const normalized = normalizeTaobaoResponse({ tbk_dg_material_optional_response: { result_list: { map_data: [{ item_id: 1, title: '灯', pict_url: 'img', zk_final_price: '39.9', coupon_amount: '5', coupon_share_url: 'url' }] } } });
  assert.deepEqual(normalized.items[0], { id: '1', title: '灯', imageUrl: 'img', price: 39.9, originalPrice: null, coupon: 5, commissionRate: null, shopName: '', sales: null, promotionUrl: 'url', source: 'taobao' });
  const couponText = normalizeTaobaoResponse({ tbk_dg_material_optional_response: { result_list: { map_data: [{ item_id: 2, coupon_info: '满100减20' }] } } });
  assert.equal(couponText.items[0].coupon, 20);
  const recommended = normalizeTaobaoResponse({ tbk_dg_material_recommend_response: { result_list: { map_data: [{ item_id: 'new-1', item_basic_info: { title: '推荐灯', pict_url: '//img.example/lamp.jpg', shop_title: '生活店' }, price_promotion_info: { final_promotion_price: '29.9', promotion_fee: '5' }, publish_info: { coupon_share_url: '//uland.example/coupon' } }] } } });
  assert.equal(recommended.items[0].title, '推荐灯');
  assert.equal(recommended.items[0].imageUrl, 'https://img.example/lamp.jpg');
  assert.equal(recommended.items[0].promotionUrl, 'https://uland.example/coupon');
  const upgraded = normalizeTaobaoResponse({ tbk_dg_material_optional_upgrade_response: { result_list: { map_data: [{ item_id: 'upgrade-1', item_basic_info: { title: '升级搜索灯', pict_url: 'img-upgrade', shop_title: '升级店' }, price_promotion_info: { final_promotion_price: '39' }, publish_info: { click_url: 'upgrade-url' } }] } } });
  assert.equal(upgraded.items[0].title, '升级搜索灯');
  assert.equal(upgraded.items[0].promotionUrl, 'upgrade-url');
});

test('超时和错误响应可被识别', async () => {
  const env = { TAOBAO_APP_KEY: 'k', TAOBAO_APP_SECRET: 's', TAOBAO_ADZONE_ID: 'z' };
  const timeout = await searchTaobao({ query: '灯', env, timeoutMs: 1, fetchImpl: async (_url, options) => new Promise((_, reject) => { options.signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); }); }) });
  assert.equal(timeout.error.code, 'TIMEOUT');
  const failed = await searchTaobao({ query: '灯', env, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ error_response: { code: 27, msg: 'Invalid signature' } }) }) });
  assert.equal(failed.error.code, 'SIGNATURE_ERROR');
  const permission = await searchTaobao({ query: '灯', env, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ error_response: { code: 15, msg: 'Insufficient permission' } }) }) });
  assert.equal(permission.error.code, 'PERMISSION_ERROR');
  const limited = await searchTaobao({ query: '灯', env, fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }) });
  assert.equal(limited.error.code, 'RATE_LIMITED');
});

test('淘宝无结果不会被当成服务崩溃', () => {
  const result = normalizeTaobaoResponse({ error_response: { code: 15, msg: 'Remote service error', sub_code: '50001', sub_msg: '无结果' } });
  assert.deepEqual(result, { ok: true, items: [], notice: '无结果' });
});

test('MVP Agent 会追问并记住本轮明确条件', async () => {
  const sessionId = 'agent-test';
  resetSession(sessionId);
  const question = await chat({ sessionId, message: '我想买点东西', search: async () => ({ ok: true, items: [] }) });
  assert.equal(question.type, 'question');
  const result = await chat({ sessionId, message: '我想找日系桌面灯，预算100元以内', search: async ({ query, filters }) => {
    assert.match(query, /日系桌面灯/);
    assert.equal(filters.end_price, 100);
    return { ok: true, items: [{ id: '1', title: '日系桌面灯' }] };
  } });
  assert.equal(result.type, 'results');
  assert.equal(result.items[0].id, '1');
  assert.equal(result.memory.preferences.maxPrice, 100);
  resetSession(sessionId);
});

test('追问上一轮商品时不应重新搜索', async () => {
  const sessionId = 'agent-context-test';
  resetSession(sessionId);
  const search = async () => ({ ok: true, items: [{ id: 'table-1', title: '日系原木餐桌', price: 1200 }] });
  const first = await chat({ sessionId, message: '我想找日系餐桌', search });
  assert.equal(first.items[0].id, 'table-1');
  const followup = await chat({ sessionId, message: '我家是奶油黄墙面，这三款你更推荐哪一款？', search: async () => { throw new Error('不应该重新搜索'); } });
  assert.equal(followup.type, 'comparison');
  assert.equal(followup.items.length, 0);
  assert.match(followup.message, /第1款/);
  resetSession(sessionId);
});

test('搜索餐桌时过滤椅子主商品，但保留餐桌商品', async () => {
  const sessionId = 'table-category-filter-test';
  resetSession(sessionId);
  const result = await chat({
    sessionId,
    message: '我想买一个日系的餐桌',
    search: async () => ({ ok: true, items: [
      { id: 'chair-1', title: '简约北欧实木靠背椅餐椅家用书桌日系餐桌椅', price: 299 },
      { id: 'table-1', title: '北欧实木餐桌家用客厅原木日系餐桌椅简约创意椭圆形桌子', price: 1299 },
      { id: 'chair-2', title: '简约北欧定型棉酒店靠背椅子餐椅家用书桌日系餐桌椅', price: 199 },
    ] })
  });
  assert.equal(result.type, 'results');
  assert.deepEqual(result.items.map((item) => item.id), ['table-1']);
  resetSession(sessionId);
});

test('严格筛选不足三款时扩展类目搜索补齐三款', async () => {
  const sessionId = 'table-expand-search-test';
  resetSession(sessionId);
  let calls = 0;
  const result = await chat({
    sessionId,
    message: '我想买一个日系的餐桌',
    search: async ({ query }) => {
      calls += 1;
      if (calls === 1) return { ok: true, items: [
        { id: 'chair-1', title: '靠背椅餐椅家用日系餐桌椅', price: 299 },
        { id: 'table-1', title: '日系原木餐桌', price: 1299 },
        { id: 'table-1-copy', title: '日系原木餐桌', price: 1299 },
      ] };
      assert.equal(query, '餐桌');
      return { ok: true, items: [
        { id: 'table-2', title: '日系实木餐桌家用桌子', price: 999 },
        { id: 'table-3', title: '日系简约餐桌小户型餐台', price: 699 },
      ] };
    }
  });
  assert.equal(result.type, 'results');
  assert.equal(result.items.length, 3);
  assert.deepEqual(result.items.map((item) => item.id).sort(), ['table-1', 'table-2', 'table-3']);
  resetSession(sessionId);
});
