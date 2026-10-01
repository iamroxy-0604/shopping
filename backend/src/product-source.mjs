import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeOpenFoodFactsResponse } from './open-food-facts.mjs';
import { searchTaobao } from './taobao.mjs';

const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/open-food-facts-sample.json');
const terms = new Map([
  ['巧克力', 'nutella'], ['榛子', 'nutella'], ['可乐', 'cola'],
  ['饮料', 'beverage'], ['饼干', 'biscuits'], ['零食', 'snacks']
]);

export function searchOpenFoodFactsSample({ query, filters = {}, sample = null }) {
  const data = sample || JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const words = String(query || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  const aliases = [...terms].filter(([chinese]) => String(query || '').includes(chinese)).map(([, english]) => english);
  const wanted = [...new Set([...words, ...aliases])];
  const items = data.products
    .map((payload) => normalizeOpenFoodFactsResponse(payload, String(payload.product.code), { retrievedAt: data.retrievedAt }))
    .filter(Boolean)
    .map((item) => {
      const searchable = [item.title, item.facts.brand, ...item.facts.categoryTags].join(' ').toLowerCase();
      return { item, score: wanted.reduce((score, term) => score + (searchable.includes(term) ? 1 : 0), 0) };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ item }) => item);
  return { ok: true, items: items.slice(0, Number(filters.pageSize) || 20), source: 'open-food-facts-sample' };
}

export async function searchProductSource({ query, filters = {}, source, env = process.env, searchTaobaoImpl = searchTaobao }) {
  const selected = source || env.SHOPPING_PRODUCT_SOURCE || 'taobao';
  if (selected === 'open-food-facts-sample') return searchOpenFoodFactsSample({ query, filters });
  if (selected === 'taobao') return searchTaobaoImpl({ query, filters, env });
  return { ok: false, error: { code: 'INVALID_SOURCE', message: '不支持的商品数据源' } };
}
