import { parseShoppingQuery } from './query.mjs';
import { searchTaobao } from './taobao.mjs';
import { understandShoppingMessage, generateRecommendationReasons, generateShoppingIntro, generateCurrentRecommendationReply } from './llm.mjs';
import { logEvent } from './logger.mjs';

const sessions = new Map();

function getSession(sessionId) {
  if (!sessions.has(sessionId)) sessions.set(sessionId, { preferences: {}, turns: [], currentRecommendation: null });
  return sessions.get(sessionId);
}

function mergePreferences(session, parsed) {
  if (parsed.extracted.category) session.preferences.category = parsed.extracted.category;
  if (parsed.extracted.priceRange?.max !== undefined && parsed.extracted.priceRange?.max !== null) session.preferences.maxPrice = parsed.extracted.priceRange.max;
  if (parsed.query) session.preferences.lastQuery = parsed.query;
  if (parsed.extracted.style) session.preferences.style = parsed.extracted.style;
  if (parsed.extracted.scene) session.preferences.scene = parsed.extracted.scene;
  if (parsed.memoryTags?.length) {
    session.preferences.memoryTags = [...new Set([...(session.preferences.memoryTags || []), ...parsed.memoryTags])]
      .filter((tag) => tag && !/有推荐吗|帮我看看|帮我找|我想买|给我推荐/.test(tag))
      .slice(-8);
  }
}

function scoreAndSelect(items, parsed, session, diagnostics = []) {
  const category = String(parsed.extracted.category || session.preferences.category || '').toLowerCase();
  const style = String(parsed.extracted.style || session.preferences.style || '').toLowerCase();
  const scene = String(parsed.extracted.scene || session.preferences.scene || '').toLowerCase();
  const styleTerms = style.split(/\s+/).filter(Boolean);
  const terms = [category, ...styleTerms, ...scene.split(/\s+/)].filter(Boolean);
  const budget = session.preferences.maxPrice;
  const seen = new Set();
  return items.map((item) => {
    const title = String(item.title || '').toLowerCase();
    const duplicateKey = title.replace(/[^\u4e00-\u9fa5a-z0-9]/gi, '').slice(0, 28);
    if (!item.title || seen.has(duplicateKey)) { diagnostics.push({ title: item.title, reason: 'missing_title_or_duplicate' }); return null; }
    if (category === '化妆品' && /化妆包|收纳|整理|收纳盒|洗漱包/.test(title) && items.length >= 3) { diagnostics.push({ title: item.title, reason: 'cosmetics_storage_mismatch' }); return null; }
    const isTableCategory = /餐桌|桌子|书桌|办公桌|茶几|餐台/.test(category);
    const isTableTextile = /桌布|桌垫|桌旗|桌巾|桌罩|餐垫|台布/.test(title);
    const isTableDecor = /摆设|摆件|插花|花材|永生花|干花|花瓶|软装|装饰|桌面装饰/.test(title);
    if (isTableCategory && (isTableTextile || isTableDecor)) { diagnostics.push({ title: item.title, reason: 'table_textile_or_decor' }); return null; }
    const chairMatch = title.match(/靠背椅|餐椅|椅子|座椅|扶手椅|吧椅|休闲椅/);
    const tableMatch = title.match(/餐桌|饭桌|桌子|餐台/);
    const isChairPrimary = chairMatch && (!tableMatch || chairMatch.index < tableMatch.index);
    if (isTableCategory && isChairPrimary) { diagnostics.push({ title: item.title, reason: 'chair_primary_mismatch' }); return null; }
    const categoryMatched = category && (title.includes(category) || (isTableCategory && /餐桌|桌子|餐台/.test(title)));
    if (category && !categoryMatched && !title.includes(category.slice(-2))) { diagnostics.push({ title: item.title, reason: `category_mismatch:${category}` }); return null; }
    seen.add(duplicateKey);
    const categoryScore = category && title.includes(category) ? 35 : 0;
    const keywordScore = Math.min(25, terms.filter((term) => title.includes(term)).length * 12);
    const styleScore = style ? Math.min(20, styleTerms.filter((term) => title.includes(term)).length * 10) : 10;
    const price = Number(item.price);
    const priceScore = budget && Number.isFinite(price) ? (price <= budget ? 10 : -15) : 0;
    const qualityScore = Math.min(10, (Number(item.sales) > 0 ? 5 : 0) + (item.coupon ? 2 : 0) + (item.shopName ? 3 : 0));
    const reasons = [];
    if (categoryScore) reasons.push(`符合${parsed.extracted.category || session.preferences.category}`);
    if (style && title.includes(style)) reasons.push(`带有${parsed.extracted.style || session.preferences.style}风格`);
    if (budget && Number.isFinite(price) && price <= budget) reasons.push(`价格在${budget}元预算内`);
    return { ...item, matchScore: categoryScore + keywordScore + styleScore + priceScore + qualityScore, matchReasons: reasons.slice(0, 2) };
  }).filter(Boolean).sort((a, b) => b.matchScore - a.matchScore).slice(0, 3);
}

function buildSearchQuery(session, parsed) {
  const style = String(session.preferences.style || '');
  const category = String(session.preferences.category || '');
  const scene = String(session.preferences.scene || '');
  const core = [style, category].filter(Boolean).join('');
  const stableParts = [core || style || category, scene].filter(Boolean);
  const currentParts = String(parsed.query || '').split(/\s+/).filter(Boolean)
    .filter((part) => {
      const normalized = part.replace(/风格/g, '');
      return part !== style && part !== category && part !== scene && part !== core && normalized !== core && normalized !== style.replace(/风格/g, '') && !(style && category && normalized.includes(style.replace(/风格/g, '')) && normalized.includes(category));
    });
  const parts = [...stableParts, ...currentParts]
    .flatMap((part) => String(part).split(/\s+/)).map((part) => part.trim()).filter(Boolean);
  return [...new Set(parts)].join(' ');
}

export function resetSession(sessionId) {
  sessions.delete(sessionId);
}

export function getSessionSnapshot(sessionId) {
  const session = getSession(sessionId);
  return { preferences: { ...session.preferences }, turns: session.turns.length, currentRecommendationCount: session.currentRecommendation?.items?.length || 0 };
}

export async function chat({ sessionId = 'anonymous', message, search = searchTaobao }) {
  const session = getSession(sessionId);
  const text = String(message ?? '').trim();
  logEvent('chat_received', { sessionId, message: text });
  if (!text) return { ok: true, type: 'question', message: '你想找什么商品？也可以告诉我预算、风格或使用场景。', items: [], memory: getSessionSnapshot(sessionId) };

  const fallback = parseShoppingQuery(text);
  const interpreted = await understandShoppingMessage({ message: text, memory: session.preferences });
  const parsed = interpreted ? {
    query: interpreted.query || fallback.query,
    filters: {
      ...fallback.filters,
      ...(interpreted.minPrice !== null ? { start_price: interpreted.minPrice } : {}),
      ...(interpreted.maxPrice !== null ? { end_price: interpreted.maxPrice } : {})
    },
    extracted: {
      keywords: interpreted.query || fallback.extracted.keywords,
      category: interpreted.category || fallback.extracted.category,
      style: interpreted.style || fallback.extracted.style,
      scene: interpreted.scene || fallback.extracted.scene,
      priceRange: interpreted.maxPrice !== null || interpreted.minPrice !== null ? { min: interpreted.minPrice, max: interpreted.maxPrice } : fallback.extracted.priceRange
    },
      needsClarification: interpreted.needsClarification,
      question: interpreted.question,
      memoryTags: interpreted.memoryTags,
      memorySummary: interpreted.memorySummary,
      intent: interpreted.intent,
      referencedIndex: interpreted.referencedIndex
  } : fallback;
  logEvent('query_understood', { sessionId, understanding: interpreted ? 'llm' : 'fallback', parsed });
  const hasCurrentRecommendation = Boolean(session.currentRecommendation?.items?.length);
  const fallbackReferencesCurrent = /这几款|这三款|哪一款|哪个更|第一款|第二款|第三款|上一轮|刚才的|这个商品|这款/.test(text);
  const followupIntent = (parsed.intent && parsed.intent !== 'new_search') ? parsed.intent : (fallbackReferencesCurrent ? 'compare_current' : (parsed.intent || 'new_search'));
  if (hasCurrentRecommendation && ['compare_current', 'ask_detail'].includes(followupIntent)) {
    mergePreferences(session, parsed);
    const currentItems = session.currentRecommendation.items;
    const reply = await generateCurrentRecommendationReply({ message: text, preferences: session.preferences, items: currentItems });
    const fallbackReply = `如果结合你刚才补充的情况，我会优先考虑第${parsed.referencedIndex || 1}款。它和你之前的${session.preferences.style || ''}风格更协调，其他几款可以作为备选。`;
    session.turns.push({ role: 'user', message: text, intent: followupIntent, result: 'current_recommendation' });
    logEvent('current_recommendation_followup', { sessionId, intent: followupIntent, itemIds: currentItems.map((item) => item.id) });
    return { ok: true, type: 'comparison', message: reply || fallbackReply, items: [], memory: getSessionSnapshot(sessionId), llm: { intent: interpreted ? 'used' : 'fallback', comparison: reply ? 'used' : 'fallback' } };
  }
  const hasKnownCategory = Boolean(parsed.extracted.category || session.preferences.category);
  if ((parsed.needsClarification || (!hasKnownCategory && /^(我想买|想买点|随便看看|帮我推荐|买东西)/.test(text)))) {
    mergePreferences(session, parsed);
    session.turns.push({ role: 'user', message: text });
    return { ok: true, type: 'question', message: parsed.question || '可以。你想买哪一类？比如桌面好物、衣服、家居或数码产品。', items: [], understanding: interpreted ? 'llm' : 'fallback', memory: getSessionSnapshot(sessionId) };
  }

  mergePreferences(session, parsed);
  const query = buildSearchQuery(session, parsed);
  const filters = {};
  if (session.preferences.maxPrice !== undefined) filters.end_price = session.preferences.maxPrice;
  if (parsed.filters.start_price !== undefined) filters.start_price = parsed.filters.start_price;
  let searchedQuery = query;
  let result = await search({ query: searchedQuery, filters });
  if (result.ok && result.items.length === 0) {
    const styleCore = String(session.preferences.style || '').split(/\s+/).filter(Boolean)[0] || '';
    const stableRetryQuery = [styleCore, session.preferences.category].filter(Boolean).join('');
    const retryQueries = [stableRetryQuery].filter((candidate, index, list) => candidate && candidate !== searchedQuery && list.indexOf(candidate) === index);
    for (const retryQuery of retryQueries) {
      searchedQuery = retryQuery;
      result = await search({ query: searchedQuery, filters });
      if (!result.ok || result.items.length > 0) break;
    }
  }
  session.turns.push({ role: 'user', message: text, query: searchedQuery, result: result.ok ? 'success' : result.error.code });
  if (!result.ok) {
    logEvent('search_failed', { sessionId, query: searchedQuery, error: result.error });
    return { ok: false, type: 'error', message: result.error.message, error: result.error, items: [], memory: getSessionSnapshot(sessionId) };
  }
  const recalledCount = result.items.length;
  const budgetText = session.preferences.maxPrice ? `，预算控制在 ${session.preferences.maxPrice} 元以内` : '';
  let selectionMode = 'strict';
  const diagnostics = [];
  let selectedItems = scoreAndSelect(result.items, parsed, session, diagnostics);
  if (!selectedItems.length && result.items.length) {
    const relaxedParsed = { ...parsed, extracted: { ...parsed.extracted, style: null } };
    const relaxedSession = { ...session, preferences: { ...session.preferences, style: '' } };
    selectedItems = scoreAndSelect(result.items, relaxedParsed, relaxedSession, diagnostics);
    selectionMode = 'category_fallback';
  }
  logEvent('products_ranked', { sessionId, query: searchedQuery, recalledCount, selectedCount: selectedItems.length, selectionMode, rejectedSample: diagnostics.slice(0, 10), selected: selectedItems.map((item) => ({ id: item.id, title: item.title, score: item.matchScore })) });
  const fallbackReasons = (item) => {
    const parts = [];
    if (parsed.extracted.style) parts.push(`这款是${parsed.extracted.style}风格`);
    if (parsed.extracted.category) parts.push(`适合想找${parsed.extracted.category}的人`);
    if (session.preferences.maxPrice && Number(item.price) <= session.preferences.maxPrice) parts.push(`价格也在${session.preferences.maxPrice}元预算内`);
    return parts.slice(0, 2).join('，') || '和你这次的搜索方向比较贴合';
  };
  selectedItems = selectedItems.map((item) => ({ ...item, recommendation: fallbackReasons(item) }));
  const recommendations = await generateRecommendationReasons({ message: text, preferences: session.preferences, items: selectedItems, timeoutMs: 30000 });
  if (recommendations) selectedItems = selectedItems.map((item) => ({ ...item, ...(recommendations[item.id] || {}), recommendation: recommendations[item.id]?.recommendation || item.recommendation }));
  const introFallback = `${parsed.extracted.style ? `我记住了，你偏好${parsed.extracted.style}风格。` : '我先根据你刚才的需求帮你看了一轮。'}我挑了 ${selectedItems.length} 款${selectionMode === 'category_fallback' ? '类目符合、但风格还需要再确认的' : '更合适的'}${parsed.extracted.category || '商品'}，你还可以告诉我更在意尺寸、材质、颜色还是使用场景。`;
  const intro = await generateShoppingIntro({ message: text, preferences: session.preferences, items: selectedItems });
  session.currentRecommendation = { query: searchedQuery, items: selectedItems, createdAt: new Date().toISOString() };
  return {
    ok: true,
    type: 'results',
    understanding: interpreted ? 'llm' : 'fallback',
    message: intro || introFallback,
    items: selectedItems,
    memory: getSessionSnapshot(sessionId),
    llm: { understanding: interpreted ? 'used' : 'fallback', memory: interpreted?.memoryTags?.length ? 'used' : 'fallback', recommendations: recommendations ? 'used' : 'fallback' }
  };
}
