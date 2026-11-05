import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchTaobao } from '../../backend/src/taobao.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scenario = JSON.parse(fs.readFileSync(path.join(here, 'scenario.json'), 'utf8'));
const maxBatches = 5;
const batchSize = 3;
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = path.join(here, 'runs', runId);
fs.mkdirSync(outputDir, { recursive: true });
const logPath = path.join(outputDir, 'events.jsonl');
const emit = (event) => fs.appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), runId, scenarioId: scenario.id, ...event }) + '\n');
// Affiliate URLs include opaque click/tracking tokens; IDs, titles and prices
// are enough to reproduce this experiment's judgments in the public log.
const minimalItem = (item) => ({ id: item.id, title: item.title, price: item.price, shopName: item.shopName, source: item.source });

export function evaluate(item, criteria) {
  const checks = {
    hasPrice: Number.isFinite(item.price),
    withinBudget: Number.isFinite(item.price) && item.price <= criteria.maxPriceYuan,
    titlePhrases: criteria.requiredTitlePhrases.map((phrase) => ({ phrase, found: String(item.title).includes(phrase) }))
  };
  return { accepted: checks.hasPrice && checks.withinBudget && checks.titlePhrases.every((x) => x.found), checks };
}

async function liveSearch({ group, batch, query, filters }) {
  emit({ type: 'search_request', group, batch, query, filters });
  const result = await searchTaobao({ query, filters });
  emit({ type: 'search_response', group, batch, query, ok: result.ok, returnedCount: result.items?.length ?? 0,
    error: result.error ? { code: result.error.code, upstreamSubCode: result.error.upstreamSubCode } : null,
    items: result.items?.map(minimalItem) ?? [] });
  return result;
}

async function runGroup(group, firstSearch) {
  const shown = new Set();
  const shownTitles = new Set();
  const feedback = [];
  const batches = [];
  let query = scenario.initialQuery;
  let maxPrice;
  let pool = firstSearch.items;
  let cursor = 0;
  let pageNo = 1;
  let reason = 'batch_limit';
  let selected = null;
  emit({ type: 'group_start', group, initialRequest: scenario.initialRequest, privateCriteria: scenario.privateCriteria });
  for (let batch = 1; batch <= maxBatches; batch++) {
    if (batch > 1 && group === 'B' && feedback.length) {
      const last = feedback.at(-1);
      if (last.queryTerm) query = [query, last.queryTerm].join(' ');
      if (last.maxPriceYuan) maxPrice = last.maxPriceYuan;
      pool = [];
      cursor = 0;
      pageNo = 1;
    }
    if (batch > 1 && group === 'A') {
      // A only paginates the same query; no private criterion enters search.
      if (cursor + batchSize > pool.length) { pageNo++; pool = []; cursor = 0; }
    }
    if (!pool.length) {
      const result = await liveSearch({ group, batch, query, filters: { pageNo, pageSize: 20, ...(maxPrice ? { end_price: maxPrice } : {}) } });
      if (!result.ok) { reason = `search_error:${result.error.code}`; break; }
      pool = result.items;
    }
    // Preserve ranked order and exclude all previously displayed IDs.
    let candidates = pool.slice(cursor).filter((item) => item.id && !shown.has(item.id) && !shownTitles.has(item.title));
    if (candidates.length < batchSize && group === 'A') {
      pageNo++;
      const result = await liveSearch({ group, batch, query, filters: { pageNo, pageSize: 20 } });
      if (!result.ok) { reason = `search_error:${result.error.code}`; break; }
      pool = result.items;
      cursor = 0;
      candidates = pool.filter((item) => item.id && !shown.has(item.id) && !shownTitles.has(item.title));
    }
    const displayed = candidates.slice(0, batchSize);
    if (!displayed.length) { reason = 'no_new_products'; break; }
    cursor = pool.indexOf(displayed.at(-1)) + 1;
    displayed.forEach((item) => { shown.add(item.id); shownTitles.add(item.title); });
    const judged = displayed.map((item) => ({ ...minimalItem(item), judgment: evaluate(item, scenario.privateCriteria) }));
    selected = judged.find((item) => item.judgment.accepted) ?? null;
    batches.push({ batch, query, displayedCount: judged.length, items: judged, satisfied: Boolean(selected) });
    emit({ type: 'batch_judged', group, batch, query, items: judged, satisfied: Boolean(selected), selectedId: selected?.id ?? null });
    if (selected) { reason = 'satisfied'; break; }
    const next = group === 'B' ? scenario.feedbackSequence[feedback.length] : null;
    const userFeedback = next ? { satisfaction: '不满意', message: next.message, queryTerm: next.queryTerm, maxPriceYuan: next.maxPriceYuan } : { satisfaction: '不满意', message: '不满意' };
    feedback.push(userFeedback);
    emit({ type: 'user_feedback', group, batch, ...userFeedback });
  }
  const summary = { group, status: reason === 'satisfied' ? 'success' : 'failure', stopReason: reason,
    batchesShown: batches.length, satisfactionBatch: selected ? batches.length : null,
    feedbackAttributes: feedback.filter((x) => x.queryTerm || x.maxPriceYuan).length,
    selectedId: selected?.id ?? null, batches };
  emit({ type: 'group_end', group, ...Object.fromEntries(Object.entries(summary).filter(([key]) => key !== 'batches')) });
  return summary;
}

const configReady = ['TAOBAO_APP_KEY', 'TAOBAO_APP_SECRET', 'TAOBAO_ADZONE_ID'].every((key) => process.env[key]);
if (!configReady) throw new Error('Missing Taobao credentials: run with node --env-file=backend/.env');
emit({ type: 'experiment_start', protocol: { maxBatches, batchSize, groups: ['A', 'B'], source: 'live_taobao', judgment: 'automatic_title_and_price' }, scenario });
const firstSearch = await liveSearch({ group: 'shared', batch: 1, query: scenario.initialQuery, filters: { pageNo: 1, pageSize: 20 } });
if (!firstSearch.ok) throw new Error(`Initial Taobao search failed: ${firstSearch.error.code}`);
const A = await runGroup('A', firstSearch);
const B = await runGroup('B', firstSearch);
const summary = { runId, scenarioId: scenario.id, source: 'live_taobao', judgment: 'automatic_title_and_price', maxBatches, batchSize,
  A, B, pairedDifferenceBMinusA: A.satisfactionBatch && B.satisfactionBatch ? B.satisfactionBatch - A.satisfactionBatch : null };
fs.writeFileSync(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ outputDir, A: { status: A.status, batches: A.batchesShown }, B: { status: B.status, batches: B.batchesShown, feedbackAttributes: B.feedbackAttributes } }, null, 2));
