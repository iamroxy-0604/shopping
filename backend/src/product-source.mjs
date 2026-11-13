import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeOpenFoodFactsResponse } from './open-food-facts.mjs';
import { searchTaobao } from './taobao.mjs';
import { searchYuemai } from './yuemai.mjs';

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

function sourceNames({ source, env }) {
  const configured = source || env.SHOPPING_PRODUCT_SOURCES || env.SHOPPING_PRODUCT_SOURCE || 'taobao';
  const names = (Array.isArray(configured) ? configured : String(configured).split(','))
    .map((name) => String(name).trim().toLowerCase())
    .map((name) => name === 'syh' ? 'yuemai' : name)
    .filter(Boolean);
  return [...new Set(names)];
}

function namespaceItems(items, source) {
  return (Array.isArray(items) ? items : []).map((item) => {
    if (!item || typeof item !== 'object') return item;
    const id = String(item.id || item.product_id || item.title || '');
    if (!id) return null;
    const prefix = `${source}:`;
    return { ...item, id: id.startsWith(prefix) ? id : `${prefix}${id}`, source: item.source ?? source };
  }).filter(Boolean);
}

function interleave(groups) {
  const result = [];
  const longest = Math.max(0, ...groups.map((group) => group.length));
  for (let index = 0; index < longest; index += 1) {
    for (const group of groups) if (group[index]) result.push(group[index]);
  }
  return result;
}

export async function searchProductSource({
  query,
  filters = {},
  source,
  env = process.env,
  searchTaobaoImpl = searchTaobao,
  searchYuemaiImpl = searchYuemai
}) {
  const selected = sourceNames({ source, env });
  const supported = new Set(['open-food-facts-sample', 'taobao', 'yuemai']);
  const invalid = selected.filter((name) => !supported.has(name));
  if (!selected.length || invalid.length) {
    return { ok: false, error: { code: 'INVALID_SOURCE', message: `不支持的商品数据源${invalid.length ? `：${invalid.join(', ')}` : ''}` } };
  }

  const searches = selected.map(async (name) => {
    try {
      const result = name === 'open-food-facts-sample'
        ? searchOpenFoodFactsSample({ query, filters })
        : name === 'taobao'
          ? await searchTaobaoImpl({ query, filters, env })
          : await searchYuemaiImpl({ query, filters, env });
      return { name, result };
    } catch {
      return { name, result: { ok: false, error: { code: 'SOURCE_UNAVAILABLE', message: `${name} 商品源暂时不可用` } } };
    }
  });
  const completed = await Promise.all(searches);
  const successful = completed.filter(({ result }) => result?.ok);
  const sources = completed.map(({ name, result }) => ({
    source: name,
    ok: result?.ok === true,
    count: result?.ok && Array.isArray(result.items) ? result.items.length : 0,
    error: result?.ok ? undefined : result?.error
  }));
  if (!successful.length) {
    const firstError = completed[0]?.result?.error;
    return { ok: false, items: [], sources, error: { code: 'ALL_SOURCES_FAILED', message: firstError?.message || '所有商品数据源暂时不可用' } };
  }

  const groups = successful.map(({ name, result }) => namespaceItems(result.items, name));
  const warnings = sources.filter((entry) => !entry.ok).map((entry) => ({ source: entry.source, ...entry.error }));
  return {
    ok: true,
    items: interleave(groups),
    source: selected.length > 1 ? 'multi' : selected[0],
    sources,
    ...(warnings.length ? { warnings } : {})
  };
}
