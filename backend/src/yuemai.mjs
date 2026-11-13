import crypto from 'node:crypto';

export const YUEMAI_PRODUCTION_BASE_URL = 'https://syh-open.senynet.com';

function ordinalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function finiteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const match = String(value).match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

function firstUrl(...values) {
  const queue = values.flat(Infinity);
  for (const candidate of queue) {
    const value = typeof candidate === 'string'
      ? candidate
      : candidate && typeof candidate === 'object'
        ? candidate.url ?? candidate.imageUrl ?? candidate.image ?? candidate.src
        : '';
    if (typeof value !== 'string' || !value.trim()) continue;
    const normalized = value.startsWith('//') ? `https:${value}` : value.trim();
    try {
      const parsed = new URL(normalized);
      if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) return parsed.href;
    } catch {
      // The provider sometimes omits optional image and detail URLs.
    }
  }
  return '';
}

function positiveInteger(value, fallback, maximum = 100) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

export function signYuemaiRequest(params, appSecret) {
  const plain = Object.keys(params)
    .filter((key) => key !== 'sign')
    .sort(ordinalCompare)
    .map((key) => `${key}=${String(params[key])}`)
    .join('&')
    .toLowerCase() + appSecret;
  return crypto.createHash('md5').update(plain, 'utf8').digest('hex').toLowerCase();
}

export function buildYuemaiParams({ appKey, query, filters = {}, pageSize = 20 }) {
  const params = {
    appkey: appKey,
    page: String(positiveInteger(filters.pageNo ?? filters.page, 1)),
    pageSize: String(positiveInteger(filters.pageSize, positiveInteger(pageSize, 20)))
  };
  if (query?.trim()) params.goodsName = query.trim();
  return params;
}

function normalizeSku(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const stock = finiteNumber(raw.stock ?? raw.stockNum ?? raw.availableStock);
  const price = finiteNumber(raw.agentPrice ?? raw.price ?? raw.salePrice);
  const originalPrice = finiteNumber(raw.marketPrice ?? raw.originalPrice ?? raw.retailPrice ?? raw.tagPrice);
  return {
    skuId: String(raw.skuId ?? raw.id ?? ''),
    name: String(raw.name ?? raw.skuName ?? '').trim(),
    price,
    originalPrice,
    stock,
    weight: finiteNumber(raw.weight),
    specs: Array.isArray(raw.specList)
      ? raw.specList.filter(Boolean).map((spec) => ({ name: String(spec.name ?? ''), value: String(spec.value ?? '') }))
      : []
  };
}

function normalizeYuemaiItem(goods) {
  if (!goods || typeof goods !== 'object') return null;
  const goodsId = String(goods.id ?? goods.goodsId ?? '').trim();
  const title = String(goods.name ?? goods.goodsName ?? goods.title ?? '').trim();
  if (!goodsId || !title) return null;

  const skus = (Array.isArray(goods.skuList) ? goods.skuList : []).map(normalizeSku).filter(Boolean);
  const availableSkus = skus.filter((sku) => sku.stock === null || sku.stock > 0);
  if (skus.length && !availableSkus.length) return null;
  const pricedSkus = availableSkus.filter((sku) => sku.price !== null).sort((left, right) => left.price - right.price);
  const representativeSku = pricedSkus[0] ?? availableSkus[0] ?? null;
  const price = representativeSku?.price ?? finiteNumber(goods.agentPrice ?? goods.price ?? goods.salePrice);
  const originalPrice = representativeSku?.originalPrice
    ?? finiteNumber(goods.marketPrice ?? goods.originalPrice ?? goods.retailPrice);

  const imageUrl = firstUrl(
    goods.mainImage,
    goods.mainImageUrl,
    goods.image,
    goods.imageUrl,
    goods.goodsImage,
    goods.cover,
    goods.coverUrl,
    goods.picUrl,
    goods.pic,
    goods.thumbnail,
    goods.imageList,
    goods.images,
    goods.goodsImages
  );
  const promotionUrl = firstUrl(goods.detailUrl, goods.goodsUrl, goods.productUrl, goods.h5Url, goods.url);
  const brand = String(goods.brandName ?? goods.brand ?? '').trim();
  const sales = finiteNumber(goods.sales ?? goods.salesVolume ?? goods.saleCount);

  return {
    id: `yuemai:${goodsId}`,
    title,
    imageUrl,
    price,
    originalPrice,
    coupon: null,
    commissionRate: null,
    shopName: brand || '悦买',
    sales,
    promotionUrl,
    source: 'yuemai',
    facts: {
      title,
      price,
      brand: brand || null,
      goodsId,
      skuCount: availableSkus.length,
      representativeSkuId: representativeSku?.skuId || null
    },
    providerData: {
      goodsId,
      skus: availableSkus.map((sku) => ({
        skuId: sku.skuId,
        name: sku.name,
        price: sku.price,
        stock: sku.stock,
        weight: sku.weight,
        specs: sku.specs
      }))
    }
  };
}

function priceMatches(item, filters) {
  const start = finiteNumber(filters.start_price ?? filters.minPrice);
  const end = finiteNumber(filters.end_price ?? filters.maxPrice);
  if (start !== null && (item.price === null || item.price < start)) return false;
  if (end !== null && (item.price === null || item.price > end)) return false;
  return true;
}

export function normalizeYuemaiResponse(payload, { filters = {} } = {}) {
  const businessCode = Number(payload?.code);
  if (!payload || businessCode !== 200) {
    const upstreamCode = payload?.code ?? 'YUEMAI_ERROR';
    const message = String(payload?.message ?? payload?.msg ?? '悦买商品接口返回错误');
    const category = /频繁|限流|rate/i.test(message) ? 'RATE_LIMITED'
      : /签名|sign/i.test(message) ? 'SIGNATURE_ERROR'
        : /权限|授权|appkey/i.test(message) ? 'PERMISSION_ERROR'
          : 'UPSTREAM_ERROR';
    return { ok: false, error: { code: category, message, upstreamCode: String(upstreamCode) } };
  }

  const list = Array.isArray(payload?.data?.list) ? payload.data.list : [];
  const items = list.map(normalizeYuemaiItem).filter(Boolean).filter((item) => priceMatches(item, filters));
  return {
    ok: true,
    items,
    source: 'yuemai',
    total: finiteNumber(payload?.data?.total) ?? items.length
  };
}

export async function searchYuemai({ query, filters = {}, env = process.env, fetchImpl = fetch, timeoutMs }) {
  const appKey = env.YUEMAI_APP_KEY || env.SYH_PROD_APPKEY;
  const appSecret = env.YUEMAI_APP_SECRET || env.SYH_PROD_APPSECRET;
  const baseUrl = String(env.YUEMAI_BASE_URL || YUEMAI_PRODUCTION_BASE_URL).replace(/\/+$/, '');
  if (!appKey || !appSecret) {
    return { ok: false, error: { code: 'CONFIG_ERROR', message: '服务端缺少悦买商品接口环境变量' } };
  }
  if (!query?.trim()) return { ok: false, error: { code: 'INVALID_QUERY', message: '搜索关键词不能为空' } };

  const params = buildYuemaiParams({ appKey, query, filters, pageSize: env.YUEMAI_PAGE_SIZE });
  params.sign = signYuemaiRequest(params, appSecret);
  const controller = new AbortController();
  const configuredTimeout = positiveInteger(timeoutMs ?? env.YUEMAI_TIMEOUT_MS, 8000, 60_000);
  const timer = setTimeout(() => controller.abort(), configuredTimeout);
  try {
    const response = await fetchImpl(`${baseUrl}/api/agent/goodsList`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: new URLSearchParams(params),
      signal: controller.signal
    });
    if (response.status === 429) return { ok: false, error: { code: 'RATE_LIMITED', message: '悦买接口请求过于频繁，请稍后再试' } };
    if (!response.ok) return { ok: false, error: { code: 'UPSTREAM_HTTP_ERROR', message: `悦买接口返回 HTTP ${response.status}` } };
    const payload = await response.json();
    return normalizeYuemaiResponse(payload, { filters });
  } catch (error) {
    if (error.name === 'AbortError') return { ok: false, error: { code: 'TIMEOUT', message: '悦买接口响应超时，请稍后再试' } };
    return { ok: false, error: { code: 'NETWORK_ERROR', message: '暂时无法连接悦买接口，请稍后再试' } };
  } finally {
    clearTimeout(timer);
  }
}
