const API_ORIGIN = 'https://world.openfoodfacts.org';
export const OPEN_FOOD_FACTS_FIELDS = [
  'code', 'product_name', 'brands', 'quantity', 'ingredients_text',
  'categories_tags', 'nutriscore_grade', 'selected_images'
];

const IMAGE_LICENSE = 'CC BY-SA';

function validBarcode(barcode) {
  return typeof barcode === 'string' && /^\d{8,14}$/.test(barcode);
}

export function buildOpenFoodFactsUrl(barcode) {
  if (!validBarcode(barcode)) throw new TypeError('barcode must be 8–14 digits as a string');
  const url = new URL(`/api/v2/product/${barcode}.json`, API_ORIGIN);
  url.searchParams.set('fields', OPEN_FOOD_FACTS_FIELDS.join(','));
  return url.toString();
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function imageFrom(product) {
  const display = product.selected_images?.front?.display;
  if (!display || typeof display !== 'object') return '';
  const candidate = display.en ?? display.fr ?? Object.values(display).find((url) => typeof url === 'string');
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && url.hostname === 'images.openfoodfacts.org' ? url.toString() : '';
  } catch {
    return '';
  }
}

export function normalizeOpenFoodFactsResponse(payload, barcode, { retrievedAt = new Date().toISOString() } = {}) {
  if (!validBarcode(barcode)) throw new TypeError('barcode must be 8–14 digits as a string');
  if (payload?.status === 0) return null;
  const product = payload?.product;
  if (payload?.status !== 1 || !product || String(product.code ?? '') !== barcode) {
    throw new TypeError('invalid or mismatched Open Food Facts product response');
  }

  const title = cleanText(product.product_name);
  const imageUrl = imageFrom(product);
  const sourceUrl = `${API_ORIGIN}/product/${barcode}`;
  const categoryTags = Array.isArray(product.categories_tags)
    ? product.categories_tags.filter((tag) => typeof tag === 'string')
    : [];
  const facts = {
    barcode,
    title,
    brand: cleanText(product.brands) || null,
    quantity: cleanText(product.quantity) || null,
    ingredientsText: cleanText(product.ingredients_text) || null,
    categoryTags,
    nutriScoreGrade: cleanText(product.nutriscore_grade) || null,
    price: null
  };

  return {
    // Flat fields retain the legacy card contract. source is structured; source.name is its card label.
    id: `off:${barcode}`,
    title,
    imageUrl,
    price: null,
    originalPrice: null,
    coupon: null,
    commissionRate: null,
    shopName: '',
    sales: null,
    promotionUrl: '',
    source: {
      type: 'open-food-facts',
      name: 'Open Food Facts',
      url: sourceUrl,
      apiUrl: buildOpenFoodFactsUrl(barcode),
      retrievedAt,
      databaseLicense: 'ODbL',
      contentsLicense: 'Database Contents License'
    },
    facts,
    media: {
      images: imageUrl ? [{ url: imageUrl, type: 'front', attribution: 'Open Food Facts contributors', license: IMAGE_LICENSE, sourceUrl }] : []
    },
    // These are deliberately empty: API facts are not model inferences or generated copy.
    semantic: {},
    generated: {}
  };
}

export function toLegacyCard(item) {
  if (!item) return null;
  const {
    id, title, imageUrl, price, originalPrice, coupon, commissionRate,
    shopName, sales, promotionUrl, source
  } = item;
  return {
    id, title, imageUrl, price, originalPrice, coupon, commissionRate,
    shopName, sales, promotionUrl, source: source.name
  };
}

export async function getOpenFoodFactsProduct({ barcode, userAgent, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  let url;
  try {
    url = buildOpenFoodFactsUrl(barcode);
  } catch {
    return { ok: false, error: { code: 'INVALID_BARCODE', message: 'barcode must be 8–14 digits' } };
  }
  if (typeof userAgent !== 'string' || !/^\S+\/\S+ \(.+\)$/.test(userAgent.trim())) {
    return { ok: false, error: { code: 'CONFIG_ERROR', message: 'Provide an identifying AppName/Version (contact) User-Agent' } };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { 'user-agent': userAgent.trim(), accept: 'application/json' },
      signal: controller.signal
    });
    if (!response.ok) {
      return { ok: false, error: { code: response.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_HTTP_ERROR', status: response.status } };
    }
    const payload = await response.json();
    return { ok: true, item: normalizeOpenFoodFactsResponse(payload, barcode) };
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') return { ok: false, error: { code: 'TIMEOUT' } };
    const invalidResponse = error instanceof SyntaxError || (error instanceof TypeError && error.message.startsWith('invalid or mismatched'));
    return { ok: false, error: { code: invalidResponse ? 'INVALID_RESPONSE' : 'NETWORK_ERROR' } };
  } finally {
    clearTimeout(timer);
  }
}
