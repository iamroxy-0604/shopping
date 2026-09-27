import crypto from 'node:crypto';

export const TAOBAO_ENDPOINT = 'https://eco.taobao.com/router/rest';

function formatBeijingTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(date).reduce((out, part) => {
    if (part.type !== 'literal') out[part.type] = part.value;
    return out;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function signTaobaoRequest(params, appSecret, signMethod = 'hmac') {
  const base = Object.keys(params).sort().map((key) => `${key}${params[key]}`).join('');
  if (signMethod === 'md5') {
    return crypto.createHash('md5').update(`${appSecret}${base}${appSecret}`, 'utf8').digest('hex').toUpperCase();
  }
  return crypto.createHmac('md5', appSecret).update(base, 'utf8').digest('hex').toUpperCase();
}

export function buildTaobaoParams({ appKey, adzoneId, query, filters = {}, timestamp = new Date(), apiMethod = 'taobao.tbk.dg.material.optional', materialId }) {
  const params = {
    app_key: appKey,
    method: apiMethod,
    format: 'json',
    v: '2.0',
    sign_method: 'hmac',
    timestamp: formatBeijingTime(timestamp),
    adzone_id: String(adzoneId),
    page_no: String(filters.pageNo ?? 1),
    page_size: String(filters.pageSize ?? 20)
  };
  if (apiMethod === 'taobao.tbk.dg.material.recommend') {
    if (materialId) params.material_id = String(materialId);
  } else {
    params.q = query;
  }
  const allowed = ['start_price', 'end_price', 'cat', 'is_tmall', 'has_coupon', 'sort'];
  for (const key of allowed) {
    if (filters[key] !== undefined && filters[key] !== null && filters[key] !== '') params[key] = String(filters[key]);
  }
  return params;
}

export function normalizeTaobaoResponse(payload) {
  if (payload?.error_response) {
    const error = payload.error_response;
    const code = String(error.code ?? 'TAOBAO_ERROR');
    const upstreamSubCode = error.sub_code ?? error.subCode ?? null;
    const message = upstreamSubCode === 'isv.permission-api-package-limit'
      ? '当前淘宝应用关联的权限包未放行该接口，请检查应用权限包和 AppKey 是否匹配'
      : upstreamSubCode === 'isv.permission-ip-whitelist-limit'
        ? '当前淘宝应用启用了 IP 白名单，但服务器 IP 不在白名单中'
        : (error.sub_msg ?? error.msg ?? '淘宝联盟接口返回错误');
    const category = /sign|签名/i.test(`${code} ${message}`) ? 'SIGNATURE_ERROR'
      : /permission|授权|权限/i.test(`${code} ${message}`) ? 'PERMISSION_ERROR'
      : /rate|频率|限流/i.test(`${code} ${message}`) ? 'RATE_LIMITED'
      : upstreamSubCode === '50001' ? 'NO_RESULTS' : 'UPSTREAM_ERROR';
    if (category === 'NO_RESULTS') return { ok: true, items: [], notice: message };
    return { ok: false, error: { code: category, message, upstreamCode: code, upstreamSubCode, upstreamMessage: error.msg ?? null } };
  }

  const result = payload?.tbk_dg_material_optional_response?.result_list?.map_data
    ?? payload?.tbk_dg_material_optional_upgrade_response?.result_list?.map_data
    ?? payload?.tbk_dg_material_recommend_response?.result_list?.map_data
    ?? [];
  return { ok: true, items: result.map((item) => ({
    id: String(item.item_id ?? item.num_iid ?? ''),
    title: item.title ?? item.item_title ?? item.item_basic_info?.title ?? '',
    imageUrl: withHttps(item.pict_url ?? item.item_pic ?? item.item_basic_info?.pict_url ?? item.small_images?.string?.[0] ?? ''),
    price: toNumber(item.final_promotion_price ?? item.zk_final_price ?? item.price_promotion_info?.final_promotion_price ?? item.reserve_price ?? item.item_price),
    originalPrice: toNumber(item.reserve_price ?? item.item_basic_info?.reserve_price ?? item.item_price),
    coupon: toCouponAmount(item.coupon_amount ?? item.coupon_info ?? item.price_promotion_info?.promotion_fee),
    commissionRate: toNumber(item.commission_rate ?? item.publish_info?.income_info?.commission_rate),
    shopName: item.shop_title ?? item.shop_name ?? item.item_basic_info?.shop_title ?? '',
    sales: item.volume ?? item.item_sales ?? item.item_basic_info?.volume ?? null,
    promotionUrl: withHttps(item.coupon_share_url ?? item.publish_info?.coupon_share_url ?? item.item_url ?? item.click_url ?? item.publish_info?.click_url ?? ''),
    source: 'taobao'
  })) };
}

function withHttps(value) {
  return value?.startsWith('//') ? `https:${value}` : (value ?? '');
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const match = String(value).match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function toCouponAmount(value) {
  if (typeof value === 'string') {
    const minus = value.match(/减\s*(\d+(?:\.\d+)?)/);
    if (minus) return Number(minus[1]);
  }
  return toNumber(value);
}

export async function searchTaobao({ query, filters = {}, env = process.env, fetchImpl = fetch, timeoutMs = 8000 }) {
  if (!env.TAOBAO_APP_KEY || !env.TAOBAO_APP_SECRET || !env.TAOBAO_ADZONE_ID) {
    return { ok: false, error: { code: 'CONFIG_ERROR', message: '服务端缺少淘宝联盟环境变量' } };
  }
  if (!query?.trim()) return { ok: false, error: { code: 'INVALID_QUERY', message: '搜索关键词不能为空' } };

  const apiMethod = env.TAOBAO_API_METHOD || 'taobao.tbk.dg.material.optional';
  if (apiMethod === 'taobao.tbk.dg.material.recommend' && !env.TAOBAO_MATERIAL_ID) {
    return { ok: false, error: { code: 'CONFIG_ERROR', message: '物料精选接口需要配置 TAOBAO_MATERIAL_ID；它不支持直接传关键词搜索' } };
  }
  const params = buildTaobaoParams({ appKey: env.TAOBAO_APP_KEY, adzoneId: env.TAOBAO_ADZONE_ID, query: query.trim(), filters, apiMethod, materialId: env.TAOBAO_MATERIAL_ID });
  params.sign = signTaobaoRequest(params, env.TAOBAO_APP_SECRET, params.sign_method);
  const body = new URLSearchParams(params);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(TAOBAO_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body,
      signal: controller.signal
    });
    if (response.status === 429) return { ok: false, error: { code: 'RATE_LIMITED', message: '淘宝接口请求过于频繁，请稍后再试' } };
    const payload = await response.json();
    if (!response.ok) return { ok: false, error: { code: 'UPSTREAM_HTTP_ERROR', message: `淘宝接口返回 HTTP ${response.status}` } };
    return normalizeTaobaoResponse(payload);
  } catch (error) {
    if (error.name === 'AbortError') return { ok: false, error: { code: 'TIMEOUT', message: '淘宝接口响应超时，请稍后再试' } };
    return { ok: false, error: { code: 'NETWORK_ERROR', message: '暂时无法连接淘宝接口，请稍后再试' } };
  } finally {
    clearTimeout(timer);
  }
}
