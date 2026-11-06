import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchTaobao } from '../../backend/src/taobao.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceFile = process.argv[2] ? path.resolve(process.argv[2]) : path.join(here, 'scenarios_v2.json');
const scenarios = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(here, 'runs', runId);
const maxBatches = 5;
const batchSize = 3;
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'scenarios_snapshot.json'), JSON.stringify(scenarios, null, 2) + '\n');
const logFile = path.join(outDir, 'events.jsonl');
const emit = (scenarioId, type, data = {}) => fs.appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), runId, scenarioId, type, ...data }) + '\n');
const publicItem = (item) => ({ id: item.id, title: item.title, price: item.price, shopName: item.shopName, source: item.source });
const key = (item) => String(item.title).replace(/[\s\p{P}]/gu, '').toLowerCase();
function uniqueCandidates(items, shownIds, shownProducts, already = [], limit = 3) {
  const selected = [];
  const ids = new Set(already.map((x) => x.id));
  const titles = new Set(already.map(key));
  for (const item of items) {
    const title = key(item);
    if (!item.id || shownIds.has(item.id) || shownProducts.has(title) || ids.has(item.id) || titles.has(title)) continue;
    selected.push(item);
    ids.add(item.id);
    titles.add(title);
    if (selected.length === limit) break;
  }
  return selected;
}

function judge(item, hard) {
  const checks = hard.map((condition) => {
    if (condition.maxPrice !== undefined) return { id: condition.id, evidence: 'api_price', status: Number.isFinite(item.price) ? (item.price <= condition.maxPrice ? 'supported' : 'contradicted') : 'unknown' };
    if (!condition.pattern) return { id: condition.id, evidence: 'detail_required', status: 'unknown' };
    const found = new RegExp(condition.pattern, 'i').test(String(item.title));
    return { id: condition.id, evidence: 'seller_title', status: found ? 'proxy_supported' : 'unknown', detailRequired: Boolean(condition.detailRequired) };
  });
  return { checks, proxyCandidate: checks.every((x) => x.status === 'supported' || x.status === 'proxy_supported'),
    confirmedSatisfied: false, reviewRequired: checks.some((x) => x.status === 'unknown' || x.evidence === 'seller_title') };
}

async function queryTaobao(scenarioId, group, batch, query, filters) {
  emit(scenarioId, 'search_request', { group, batch, query, filters });
  const result = await searchTaobao({ query, filters, timeoutMs: 12000 });
  emit(scenarioId, 'search_response', { group, batch, ok: result.ok, errorCode: result.error?.code ?? null,
    count: result.items?.length ?? 0, items: result.items?.map(publicItem) ?? [] });
  return result;
}

async function runGroup(s, group, first) {
  const shownIds = new Set();
  const shownProducts = new Set();
  const batches = [];
  const feedback = [];
  let query = s.initialQuery;
  let maxPrice;
  let pool = first.items;
  let cursor = 0;
  let pageNo = 1;
  let stopReason = 'five_batch_limit';
  emit(s.id, 'group_start', { group, initialRequest: s.initialRequest });
  for (let n = 1; n <= maxBatches; n++) {
    if (n > 1 && group === 'B' && feedback.length) {
      const last = feedback.at(-1);
      if (last.queryTerm && !query.includes(last.queryTerm)) query += ` ${last.queryTerm}`;
      if (last.maxPrice !== undefined) maxPrice = last.maxPrice;
      pool = [];
      cursor = 0;
      pageNo = 1;
    }
    let displayed = uniqueCandidates(pool.slice(cursor), shownIds, shownProducts, [], batchSize);
    if (displayed.length) cursor = pool.indexOf(displayed.at(-1)) + 1;
    const retrievalQueries = displayed.length ? ['cached_initial_or_previous_search'] : [];
    const latestTerm = feedback.at(-1)?.queryTerm;
    const plans = group === 'A'
      ? [{ q: s.initialQuery, page: pageNo + 1 }, { q: '充电宝', page: 1 }, { q: '充电宝', page: 2 }]
      : [{ q: query, page: 1 }, { q: [s.initialQuery, latestTerm].filter(Boolean).join(' '), page: 1 },
        { q: s.initialQuery, page: 1 }, { q: '充电宝', page: 1 }, { q: '充电宝', page: 2 }];
    const used = new Set();
    for (const plan of plans) {
      if (displayed.length >= batchSize) break;
      const planKey = `${plan.q}|${plan.page}`;
      if (used.has(planKey)) continue;
      used.add(planKey);
      const result = await queryTaobao(s.id, group, n, plan.q, { pageNo: plan.page, pageSize: 20,
        ...(maxPrice !== undefined ? { end_price: maxPrice } : {}) });
      retrievalQueries.push(planKey);
      if (!result.ok) { stopReason = `search_error:${result.error.code}`; break; }
      const added = uniqueCandidates(result.items, shownIds, shownProducts, displayed, batchSize - displayed.length);
      displayed.push(...added);
      if (group === 'A' && added.length) { pool = result.items; cursor = pool.indexOf(added.at(-1)) + 1; pageNo = plan.page; }
    }
    if (stopReason.startsWith('search_error:')) break;
    if (!displayed.length) { stopReason = 'no_new_products'; break; }
    displayed.forEach((item) => { shownIds.add(item.id); shownProducts.add(key(item)); });
    const items = displayed.map((item) => ({ ...publicItem(item), judgment: judge(item, s.hard) }));
    const proxy = items.find((item) => item.judgment.proxyCandidate);
    const batch = { number: n, query, retrievalQueries, displayedCount: items.length, protocolDeviation: items.length !== batchSize ? 'fewer_than_three' : null,
      items, proxyCandidateId: proxy?.id ?? null };
    batches.push(batch);
    emit(s.id, 'batch_judged', { group, ...batch });
    if (proxy) { stopReason = 'proxy_candidate_found_requires_human_review'; break; }
    if (n === maxBatches) break;
    const next = group === 'B' ? s.feedback[feedback.length] : null;
    const response = next ? { satisfaction: 'no_confirmed_satisfaction', message: next.message, conditionId: next.id,
      queryTerm: next.queryTerm ?? null, maxPrice: next.maxPrice ?? null } : { satisfaction: 'no_confirmed_satisfaction', message: '不满意', conditionId: null };
    feedback.push(response);
    emit(s.id, 'user_feedback', { group, batch: n, ...response });
  }
  const summary = { scenarioId: s.id, group, stopReason, batchesShown: batches.length, proxyCandidateBatch: batches.find((x) => x.proxyCandidateId)?.number ?? null,
    confirmedSatisfied: false, attributesRevealed: feedback.filter((x) => x.conditionId).length, incompleteBatches: batches.filter((x) => x.protocolDeviation).length, batches };
  emit(s.id, 'group_end', { group, stopReason, batchesShown: summary.batchesShown, proxyCandidateBatch: summary.proxyCandidateBatch,
    attributesRevealed: summary.attributesRevealed, incompleteBatches: summary.incompleteBatches });
  return summary;
}

if (!['TAOBAO_APP_KEY', 'TAOBAO_APP_SECRET', 'TAOBAO_ADZONE_ID'].every((name) => process.env[name])) throw new Error('Configure backend/.env before live run');
emit(null, 'experiment_start', { protocol: { batchSize, maxBatches, groups: ['A', 'B'], source: 'live_taobao',
  judgment: 'title_and_price_proxy_only', confirmedSatisfactionRequiresHumanReview: true }, scenarioCount: scenarios.length, sourceFile: path.basename(sourceFile) });
const results = [];
for (const s of scenarios) {
  emit(s.id, 'scenario_start', { initialRequest: s.initialRequest, initialQuery: s.initialQuery, hard: s.hard, soft: s.soft, feedbackPlan: s.feedback });
  const first = await queryTaobao(s.id, 'shared', 1, s.initialQuery, { pageNo: 1, pageSize: 20 });
  if (!first.ok) {
    results.push({ scenarioId: s.id, status: 'initial_search_error', errorCode: first.error.code });
    emit(s.id, 'scenario_end', { status: 'initial_search_error', errorCode: first.error.code });
    continue;
  }
  let sharedPool = [...first.items];
  for (const plan of [{ q: s.initialQuery, page: 2 }, { q: '充电宝', page: 1 }, { q: '充电宝', page: 2 }]) {
    if (uniqueCandidates(sharedPool, new Set(), new Set()).length >= batchSize) break;
    const extra = await queryTaobao(s.id, 'shared', 1, plan.q, { pageNo: plan.page, pageSize: 20 });
    if (extra.ok) sharedPool.push(...extra.items);
  }
  if (uniqueCandidates(sharedPool, new Set(), new Set()).length < batchSize) {
    results.push({ scenarioId: s.id, status: 'incomplete_shared_first_batch' });
    emit(s.id, 'scenario_end', { status: 'incomplete_shared_first_batch' });
    continue;
  }
  first.items = sharedPool;
  emit(s.id, 'shared_first_batch_ready', { items: uniqueCandidates(sharedPool, new Set(), new Set()).map(publicItem) });
  const A = await runGroup(s, 'A', first);
  const B = await runGroup(s, 'B', first);
  results.push({ scenarioId: s.id, initialRequest: s.initialRequest, A, B });
  emit(s.id, 'scenario_end', { status: 'completed', A: A.stopReason, B: B.stopReason });
  console.log(`${s.id}: A ${A.proxyCandidateBatch ?? '-'} / B ${B.proxyCandidateBatch ?? '-'} (proxy only)`);
}
const summary = { runId, source: 'live_taobao', judgment: 'title_and_price_proxy_only', scenarioCount: scenarios.length,
  pairedRunsCompleted: results.filter((r) => r.A && r.B).length, results };
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(`Saved ${outDir}`);
