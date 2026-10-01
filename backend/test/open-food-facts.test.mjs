import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  OPEN_FOOD_FACTS_FIELDS, buildOpenFoodFactsUrl,
  getOpenFoodFactsProduct, normalizeOpenFoodFactsResponse, toLegacyCard
} from '../src/open-food-facts.mjs';

const fixture = JSON.parse(await readFile(new URL('../data/open-food-facts-sample.json', import.meta.url), 'utf8'));
const userAgent = 'ShoppingAdapterTest/0.1 (tests@example.org)';

test('individual barcode GET selects only the requested fields', async () => {
  const barcode = '3017620422003';
  const expected = fixture.products[0];
  let calls = 0;
  const result = await getOpenFoodFactsProduct({
    barcode, userAgent,
    fetchImpl: async (input, options) => {
      calls += 1;
      const url = new URL(input);
      assert.equal(url.origin, 'https://world.openfoodfacts.org');
      assert.equal(url.pathname, `/api/v2/product/${barcode}.json`);
      assert.deepEqual(url.searchParams.get('fields').split(','), OPEN_FOOD_FACTS_FIELDS);
      assert.equal(options.method, 'GET');
      assert.equal(options.headers['user-agent'], userAgent);
      return { ok: true, json: async () => expected };
    }
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.item.facts.title, 'Nutella');
  assert.equal(result.item.source.url, `https://world.openfoodfacts.org/product/${barcode}`);
});

test('verified grocery snapshots retain provenance, facts, media and legacy fields', () => {
  assert.match(fixture.status, /live API verified/);
  assert.equal(fixture.products.length, 3);
  for (const payload of fixture.products) {
    const barcode = payload.product.code;
    const item = normalizeOpenFoodFactsResponse(payload, barcode, { retrievedAt: '2026-10-01T00:00:00.000Z' });
    assert.equal(item.id, `off:${barcode}`);
    assert.equal(item.title, item.facts.title);
    assert.equal(item.price, null);
    assert.equal(item.facts.price, null);
    assert.equal(item.originalPrice, null);
    assert.equal(item.promotionUrl, '');
    assert.equal(item.source.name, 'Open Food Facts');
    assert.equal(item.source.retrievedAt, '2026-10-01T00:00:00.000Z');
    assert.notEqual(item.source.url, item.promotionUrl);
    assert.deepEqual(item.semantic, {});
    assert.deepEqual(item.generated, {});
    assert.equal(item.media.images[0].url, item.imageUrl);
    assert.equal(item.media.images[0].license, 'CC BY-SA');
    assert.equal(item.media.images[0].sourceUrl, item.source.url);
    for (const key of ['coupon', 'commissionRate', 'sales']) assert.equal(item[key], null);
    assert.equal(item.shopName, '');
    const card = toLegacyCard(item);
    assert.equal(card.source, 'Open Food Facts');
    assert.equal(card.price, null);
    assert.equal(card.promotionUrl, '');
    assert.equal(card.facts, undefined);
  }
});

test('missing product, absent image and incomplete facts are handled without invention', async () => {
  const missing = await getOpenFoodFactsProduct({
    barcode: '12345678', userAgent,
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: 0 }) })
  });
  assert.deepEqual(missing, { ok: true, item: null });
  const sparse = normalizeOpenFoodFactsResponse({ status: 1, product: { code: '12345678', product_name: 'Test food' } }, '12345678');
  assert.equal(sparse.imageUrl, '');
  assert.deepEqual(sparse.media.images, []);
  assert.equal(sparse.facts.brand, null);
  assert.equal(sparse.facts.nutriScoreGrade, null);
  assert.equal(sparse.price, null);
});

test('rejects invalid identifiers and mismatched or unsafe response data', async () => {
  assert.throws(() => buildOpenFoodFactsUrl('../other'), TypeError);
  const invalid = await getOpenFoodFactsProduct({ barcode: '../other', userAgent, fetchImpl: async () => { throw new Error('must not fetch'); } });
  assert.equal(invalid.error.code, 'INVALID_BARCODE');
  const noAgent = await getOpenFoodFactsProduct({ barcode: '12345678', fetchImpl: async () => { throw new Error('must not fetch'); } });
  assert.equal(noAgent.error.code, 'CONFIG_ERROR');
  assert.throws(() => normalizeOpenFoodFactsResponse({ status: 1, product: { code: '99999999' } }, '12345678'), TypeError);
  const mismatch = await getOpenFoodFactsProduct({ barcode: '12345678', userAgent, fetchImpl: async () => ({ ok: true, json: async () => ({ status: 1, product: { code: '99999999' } }) }) });
  assert.equal(mismatch.error.code, 'INVALID_RESPONSE');
  const unsafeImage = normalizeOpenFoodFactsResponse({ status: 1, product: { code: '12345678', selected_images: { front: { display: { en: 'https://example.org/photo.jpg' } } } } }, '12345678');
  assert.equal(unsafeImage.imageUrl, '');
});

test('reports upstream HTTP errors and timeouts', async () => {
  const limited = await getOpenFoodFactsProduct({ barcode: '12345678', userAgent, fetchImpl: async () => ({ ok: false, status: 429 }) });
  assert.equal(limited.error.code, 'RATE_LIMITED');
  const unavailable = await getOpenFoodFactsProduct({ barcode: '12345678', userAgent, fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal(unavailable.error.code, 'UPSTREAM_HTTP_ERROR');
  const timeout = await getOpenFoodFactsProduct({ barcode: '12345678', userAgent, timeoutMs: 1, fetchImpl: async (_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }) });
  assert.equal(timeout.error.code, 'TIMEOUT');
});
