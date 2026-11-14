import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildYuemaiParams,
  normalizeYuemaiResponse,
  searchYuemai,
  signYuemaiRequest
} from '../src/yuemai.mjs';

test('悦买签名与现有 PowerShell 联调脚本结果一致', () => {
  const params = {
    appkey: 'papi_0123456789abcdef0123456789abcdef',
    goodsName: '门店 A+B & 包装=破损',
    page: '1',
    pageSize: '20'
  };
  const secret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  assert.equal(signYuemaiRequest(params, secret), '5b71356e5fe402fa3f6c0d21bf3801bb');
  assert.equal(signYuemaiRequest({ ...params, sign: 'ignored' }, secret), '5b71356e5fe402fa3f6c0d21bf3801bb');
});

test('悦买列表参数使用平台约定的字段名并限制分页大小', () => {
  assert.deepEqual(buildYuemaiParams({
    appKey: 'key',
    query: '充电宝',
    filters: { pageNo: 2, pageSize: 500 }
  }), { appkey: 'key', goodsName: '充电宝', page: '2', pageSize: '100' });
});

test('悦买商品按商品维度标准化并选择最低有库存 SKU 价格', () => {
  const result = normalizeYuemaiResponse({
    code: 200,
    message: 'success',
    data: {
      total: 1,
      list: [{
        id: 1001,
        name: '自带线快充充电宝',
        brandName: '示例品牌',
        coverImage: '//img.example/powerbank.jpg',
        sellingPoint: '小巧便携，支持快充',
        categoryName: '数码配件',
        detailContent: '<p>详情</p><img src="https://img.example/detail-1.jpg"><img src="javascript:alert(1)"><img src="https://img.example/detail-1.jpg">',
        skuList: [
          { skuId: 2001, name: '黑色', agentPrice: '99.00', stock: 0 },
          { skuId: 2002, name: '白色', agentPrice: '79.90', stock: 8, specList: [{ name: '颜色', value: '白色' }] },
          { skuId: 2003, name: '蓝色', agentPrice: '89.00', stock: 3 }
        ]
      }]
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0], {
    id: 'yuemai:1001',
    title: '自带线快充充电宝',
    imageUrl: 'https://img.example/powerbank.jpg',
    price: 79.9,
    originalPrice: null,
    coupon: null,
    commissionRate: null,
    shopName: '示例品牌',
    sales: null,
    promotionUrl: '',
    source: 'yuemai',
    description: '小巧便携，支持快充',
    media: {
      images: [
        { url: 'https://img.example/powerbank.jpg', role: 'cover' },
        { url: 'https://img.example/detail-1.jpg', role: 'detail' }
      ]
    },
    facts: {
      title: '自带线快充充电宝',
      price: 79.9,
      brand: '示例品牌',
      sellingPoint: '小巧便携，支持快充',
      description: '小巧便携，支持快充',
      category: '数码配件',
      deliverTime: null,
      servicePromise: null,
      afterSaleRule: null,
      goodsId: '1001',
      skuCount: 2,
      representativeSkuId: '2002'
    },
    providerData: {
      goodsId: '1001',
      detailImages: ['https://img.example/detail-1.jpg'],
      skus: [
        { skuId: '2002', name: '白色', price: 79.9, stock: 8, weight: null, specs: [{ name: '颜色', value: '白色' }] },
        { skuId: '2003', name: '蓝色', price: 89, stock: 3, weight: null, specs: [] }
      ]
    }
  });
});

test('悦买本地预算过滤不会把未知价格或超预算商品说成符合预算', () => {
  const result = normalizeYuemaiResponse({ code: 200, data: { list: [
    { id: 1, name: '预算内商品', skuList: [{ skuId: 11, agentPrice: 80, stock: 2 }] },
    { id: 2, name: '超预算商品', skuList: [{ skuId: 21, agentPrice: 180, stock: 2 }] },
    { id: 3, name: '未知价格商品', skuList: [{ skuId: 31, stock: 2 }] }
  ] } }, { filters: { end_price: 100 } });
  assert.deepEqual(result.items.map((item) => item.id), ['yuemai:1']);
});

test('悦买请求只在服务端签名并正确处理配置和业务错误', async () => {
  const missing = await searchYuemai({ query: '充电宝', env: {} });
  assert.equal(missing.error.code, 'CONFIG_ERROR');

  let request;
  const result = await searchYuemai({
    query: '充电宝',
    filters: { pageSize: 20 },
    env: { YUEMAI_APP_KEY: 'key', YUEMAI_APP_SECRET: 'secret', YUEMAI_BASE_URL: 'https://example.com/' },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ code: 200, data: { total: 0, list: [] } }) };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(request.url, 'https://example.com/api/agent/goodsList');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['content-type'], 'application/x-www-form-urlencoded; charset=utf-8');
  assert.equal(request.options.body.get('appkey'), 'key');
  assert.equal(request.options.body.get('goodsName'), '充电宝');
  assert.match(request.options.body.get('sign'), /^[a-f0-9]{32}$/);
  assert.equal(String(request.options.body).includes('secret'), false);

  const denied = normalizeYuemaiResponse({ code: 403, message: 'AppKey 权限不足' });
  assert.equal(denied.error.code, 'PERMISSION_ERROR');
});
