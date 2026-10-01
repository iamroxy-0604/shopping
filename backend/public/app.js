const sessionStorageKey = 'immersive-shopping-session-id';
const conversationsStorageKey = 'immersive-shopping-conversations';
const favoritesStorageKey = 'immersive-shopping-favorites';
const userStorageKey = 'immersive-shopping-user-id';
const userId = localStorage.getItem(userStorageKey) || `shopper-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
localStorage.setItem(userStorageKey, userId);
const memoryStorageKey = `immersive-shopping-memory-${userId}`;
let sessionId = localStorage.getItem(sessionStorageKey) || `demo-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
localStorage.setItem(sessionStorageKey, sessionId);
const form = document.querySelector('#chatForm');
const input = document.querySelector('#messageInput');
const messages = document.querySelector('#messages');
const loadingRow = document.querySelector('#loadingRow');
const newChat = document.querySelector('#newChat');
const mobileNewChat = document.querySelector('#mobileNewChat');
const memoryRail = document.querySelector('#memoryRail');
const memoryToggle = document.querySelector('#memoryToggle');
const appShell = document.querySelector('.app-shell');

function loadConversations() {
  try {
    const value = JSON.parse(localStorage.getItem(conversationsStorageKey) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

let conversations = loadConversations();
let favorites = loadFavorites();
let requestToken = 0;
let latestMemory = loadMemory();

function loadMemory() {
  try {
    const value = JSON.parse(localStorage.getItem(memoryStorageKey) || 'null');
    return value && typeof value === 'object' && value.preferences && typeof value.preferences === 'object' ? value : null;
  } catch {
    return null;
  }
}

function acceptMemory(memory) {
  if (!memory || !memory.preferences || typeof memory.preferences !== 'object') return;
  latestMemory = { preferences: memory.preferences, receivedAt: new Date().toISOString() };
  try { localStorage.setItem(memoryStorageKey, JSON.stringify(latestMemory)); } catch { /* keep the current view */ }
  updateMemory(latestMemory.preferences);
}

function loadFavorites() {
  try {
    const value = JSON.parse(localStorage.getItem(favoritesStorageKey) || '{}');
    return Object.assign(Object.create(null), value && typeof value === 'object' && !Array.isArray(value) ? value : {});
  } catch {
    return Object.create(null);
  }
}

function saveConversations() {
  try { localStorage.setItem(conversationsStorageKey, JSON.stringify(conversations)); } catch { /* ignore storage quota errors */ }
}

function currentConversation() {
  return conversations[sessionId] || null;
}

function conversationTitle(text) {
  const title = String(text || '').replace(/\s+/g, ' ').trim();
  return title.length > 18 ? `${title.slice(0, 18)}…` : title || '新对话';
}

function touchConversation(firstMessage) {
  const record = conversations[sessionId] || { id: sessionId, title: conversationTitle(firstMessage), messages: [], memory: {} };
  if (!record.title || record.title === '新对话') record.title = conversationTitle(firstMessage);
  record.updatedAt = new Date().toISOString();
  conversations[sessionId] = record;
  saveConversations();
  renderRecent();
  return record;
}

function formatConversationTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function renderRecent() {
  const recent = document.querySelector('.recent');
  if (!recent) return;
  const records = Object.values(conversations).filter((record) => record?.messages?.length).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  recent.innerHTML = `<p class="rail-title">最近对话</p>${records.slice(0, 8).map((record) => `<button class="recent-item${record.id === sessionId ? ' selected' : ''}" data-session-id="${escapeHtml(record.id)}"><span>${escapeHtml(record.title)}</span><time>${escapeHtml(formatConversationTime(record.updatedAt))}</time></button>`).join('')}`;
  recent.querySelectorAll('.recent-item').forEach((button) => button.addEventListener('click', () => openConversation(button.dataset.sessionId)));
}

function persistMessage(message) {
  const record = touchConversation(message.role === 'user' ? message.text : '');
  record.messages.push(message);
  record.updatedAt = new Date().toISOString();
  saveConversations();
  renderRecent();
}

function clearConversationView() {
  messages.innerHTML = '';
}

function openConversation(id) {
  const record = conversations[id];
  if (!record) return;
  requestToken += 1;
  sessionId = id;
  localStorage.setItem(sessionStorageKey, sessionId);
  clearConversationView();
  loadingRow.hidden = true;
  input.disabled = false;
  document.querySelector('.send-control').disabled = false;
  for (const message of record.messages || []) {
    if (message.role === 'user') appendUserMessage(message.text, false);
    if (message.role === 'assistant') appendAssistantMessage(message.result, false);
  }
  updateMemory(latestMemory?.preferences);
  renderRecent();
  document.querySelector('.conversation').scrollTo({ top: document.querySelector('.conversation').scrollHeight, behavior: 'smooth' });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function safeUrl(value, allowLocal = false) {
  const raw = String(value || '').trim();
  if (allowLocal && /^\/assets\/[\w./-]+$/.test(raw) && !raw.includes('..')) return raw;
  try {
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function favoriteKey(item) {
  const sourceName = typeof item.source === 'object' ? item.source?.name : item.source;
  return String(item.id || `${sourceName || ''}|${item.shopName || ''}|${item.title || ''}`);
}

function productCard(item) {
  const images = Array.isArray(item.media?.images) ? item.media.images : [];
  const legacyImageUrl = safeUrl(item.imageUrl, true);
  const mediaImage = images.find((entry) => safeUrl(entry?.url, true) === legacyImageUrl)
    || (!legacyImageUrl ? images.find((entry) => safeUrl(entry?.url, true)) : null);
  const imageUrl = legacyImageUrl || safeUrl(mediaImage?.url, true);
  const image = imageUrl ? `<img class="product-image" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(item.title || '商品图片')}" loading="lazy">` : '<div class="product-image image-placeholder">暂无图片</div>';
  const amount = Number(item.price);
  const price = item.price == null || !Number.isFinite(amount) || amount < 0 ? '价格待确认' : `¥${amount.toFixed(0)}`;
  const reason = item.recommendation || (item.matchReasons?.length ? item.matchReasons.join(' · ') : (item.subtitle || item.categoryName || '值得看看 · 生活好物'));
  const extra = [item.suitableFor ? `适合：${item.suitableFor}` : '', item.highlight ? `亮点：${item.highlight}` : '', item.watchout ? `注意：${item.watchout}` : ''].filter(Boolean).map(escapeHtml).join('<br>');
  const url = safeUrl(item.promotionUrl);
  const source = item.source && typeof item.source === 'object' ? item.source : null;
  const sourceName = source ? (source.name || '未知来源') : (item.source || `来自 ${item.shopName || '淘宝联盟'}`);
  const sourceUrl = safeUrl(source?.url);
  const sourceLabel = source ? `来源：${sourceName}` : sourceName;
  const citation = sourceUrl
    ? `<a class="source-citation" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer" aria-label="查看${escapeHtml(sourceName)}来源">${escapeHtml(sourceLabel)} ↗</a>`
    : `<span>${escapeHtml(sourceLabel)}</span>`;
  const creditText = mediaImage && (mediaImage.attribution || mediaImage.license)
    ? `图片：${[mediaImage.attribution, mediaImage.license].filter(Boolean).join(' · ')}` : '';
  const imageSourceUrl = safeUrl(mediaImage?.sourceUrl);
  const imageCredit = creditText ? (imageSourceUrl
    ? `<a class="image-credit" href="${escapeHtml(imageSourceUrl)}" target="_blank" rel="noopener noreferrer" aria-label="查看图片来源：${escapeHtml(creditText)}">${escapeHtml(creditText)} ↗</a>`
    : `<span class="image-credit">${escapeHtml(creditText)}</span>`) : '';
  const key = favoriteKey(item);
  const saved = Boolean(favorites[key]);
  const content = `${image}<div class="product-body"><p class="product-title">${escapeHtml(item.title || '未命名商品')}</p><p class="product-subtitle">${escapeHtml(reason)}</p>${extra ? `<p class="product-extra">${extra}</p>` : ''}<div class="product-price-row"><span class="product-price">${price}</span>${url ? '<span class="product-arrow" aria-hidden="true">↗</span>' : ''}</div></div>`;
  const details = url ? `<a class="product-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" aria-label="查看${escapeHtml(item.title || '商品')}的购买页面">${content}</a>` : `<div class="product-details">${content}</div>`;
  return `<article class="product-card"><div class="product-media">${details}<div class="product-source">${citation}${imageCredit}${url ? '' : '<span>暂无购买链接</span>'}</div><button class="favorite-button${saved ? ' is-saved' : ''}" type="button" data-favorite-key="${escapeHtml(key)}" aria-label="${saved ? '取消收藏' : '收藏'}${escapeHtml(item.title || '商品')}" aria-pressed="${saved}">${saved ? '♥' : '♡'}</button></div></article>`;
}

function renderProducts(items, target = messages) {
  target.querySelectorAll('.quick-actions').forEach((actions) => actions.remove());
  const cards = items.slice(0, 3).map(productCard).join('');
  target.insertAdjacentHTML('beforeend', `<div class="product-grid" aria-label="商品推荐">${cards}</div>${quickActions()}`);
}

function quickActions() {
  return '<div class="quick-actions" aria-label="快捷选择"><button type="button" data-quick="browse">只想逛逛</button><button type="button" data-quick="similar">相似风格</button><button type="button" data-quick="cheaper">便宜一点</button><button type="button" data-quick="replace">换一个</button></div>';
}

function showWelcome() {
  const hasPreferences = Object.entries(latestMemory?.preferences || {}).some(([field, value]) => field !== 'memoryTags' && value !== null && value !== undefined && value !== '');
  messages.innerHTML = `<div class="welcome"><span class="welcome-icon" aria-hidden="true">✦</span><h2>今天想逛点什么？</h2><p>告诉我想找的东西，也可以先随便看看。</p></div><div class="quick-actions welcome-actions" aria-label="开始探索"><button type="button" data-quick="browse">随便逛逛</button><button type="button" data-quick="similar">${hasPreferences ? '按我的偏好看看' : '看看日系桌面好物'}</button></div>`;
}

function appendUserMessage(text, persist = true) {
  messages.insertAdjacentHTML('beforeend', `<div class="message user-message"><div class="message-main"><div class="user-bubble">${escapeHtml(text)}</div><time>刚刚</time></div><span class="user-avatar" aria-label="用户头像"></span></div>`);
  if (persist) persistMessage({ role: 'user', text });
}

function appendAssistantMessage(result, persist = true) {
  messages.insertAdjacentHTML('beforeend', `<div class="message assistant-message"><span class="assistant-avatar" aria-label="购物助手"><i data-lucide="sparkles"></i></span><div class="message-main"><div class="assistant-copy">${escapeHtml(result.message)}</div><time>刚刚</time></div></div>`);
  globalThis.lucide?.createIcons();
  if (result.items?.length) renderProducts(result.items);
  if (persist) {
    const record = touchConversation('');
    record.memory = result.memory?.preferences || record.memory || {};
    persistMessage({ role: 'assistant', result: { message: result.message, type: result.type, items: result.items || [], memory: result.memory } });
  }
  document.querySelector('.conversation').scrollTo({ top: document.querySelector('.conversation').scrollHeight, behavior: 'smooth' });
}

function updateMemory(preferences) {
  const tags = document.querySelector('#memoryTags');
  const mobileMemory = document.querySelector('#mobileMemory');
  const mobileTags = document.querySelector('#mobileMemoryTags');
  const fields = [
    ['style', '风格'], ['material', '材质'], ['category', '品类'], ['scene', '场景'], ['maxPrice', '预算']
  ];
  const entries = fields.filter(([field]) => preferences?.[field] !== undefined && preferences[field] !== null && preferences[field] !== '')
    .map(([field, label]) => ({ field, label, value: String(preferences[field]) }));
  const rawTags = Array.isArray(preferences?.memoryTags) ? preferences.memoryTags : [];
  const extras = [...new Set(rawTags.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim()))]
    .filter((tag) => !entries.some(({ value }) => tag.includes(value)));
  const display = entries.map(({ field, label, value }) => ({ field, text: field === 'maxPrice' ? `预算 ¥${value} 以内` : `${label}：${value}` }))
    .concat(extras.map((text) => ({ field: '', text }))).slice(0, 8);
  const canDeleteField = new Set(['style', 'category', 'scene', 'maxPrice']);
  tags.innerHTML = display.length ? display.map(({ field, text }) => canDeleteField.has(field)
    ? `<button class="memory-tag memory-delete" type="button" data-forget-field="${field}" aria-label="删除${escapeHtml(text)}偏好"><span>${escapeHtml(text)}</span><span aria-hidden="true">×</span></button>`
    : `<span class="memory-tag">${escapeHtml(text)}</span>`).join('')
    : `<p class="memory-empty">${latestMemory ? '还没有记录偏好' : '发送消息后显示已同步偏好'}</p>`;
  mobileTags.innerHTML = display.map(({ field, text }) => canDeleteField.has(field)
    ? `<button class="memory-chip memory-delete" type="button" data-forget-field="${field}" aria-label="删除${escapeHtml(text)}偏好">${escapeHtml(text)} <span aria-hidden="true">×</span></button>`
    : `<span class="memory-chip">${escapeHtml(text)}</span>`).join('');
  document.querySelector('#forgetAllMemory').hidden = !display.length;
  mobileMemory.hidden = !display.length;
  setMemoryActionsDisabled(input.disabled);
}

function setMemoryActionsDisabled(disabled) {
  document.querySelectorAll('[data-forget-field], [data-forget-all]').forEach((button) => { button.disabled = disabled; });
}

async function sendMessage(text) {
  if (input.disabled) return;
  messages.querySelector('.welcome')?.remove();
  messages.querySelectorAll('.quick-actions').forEach((actions) => actions.remove());
  const requestedSession = sessionId;
  const token = ++requestToken;
  appendUserMessage(text);
  input.value = '';
  input.style.height = 'auto';
  loadingRow.hidden = false;
  input.disabled = true;
  document.querySelector('.send-control').disabled = true;
  setMemoryActionsDisabled(true);
  document.querySelector('.conversation').scrollTo({ top: document.querySelector('.conversation').scrollHeight, behavior: 'smooth' });
  try {
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId, sessionId, message: text }) });
    const result = await response.json();
    if (token !== requestToken || sessionId !== requestedSession) return;
    acceptMemory(result.memory);
    if (!result.ok) throw new Error(result.error?.message || '暂时没有响应');
    appendAssistantMessage(result);
  } catch (error) {
    if (token === requestToken && sessionId === requestedSession) appendAssistantMessage({ message: error.message, type: 'error', items: [] });
  } finally {
    if (token !== requestToken) return;
    loadingRow.hidden = true;
    input.disabled = false;
    document.querySelector('.send-control').disabled = false;
    setMemoryActionsDisabled(false);
    input.focus();
  }
}

messages.addEventListener('click', (event) => {
  const favorite = event.target.closest('.favorite-button');
  if (favorite && messages.contains(favorite)) {
    const key = favorite.dataset.favoriteKey;
    if (favorites[key]) delete favorites[key];
    else favorites[key] = true;
    try { localStorage.setItem(favoritesStorageKey, JSON.stringify(favorites)); } catch { /* favorite remains for this visit */ }
    document.querySelectorAll('.favorite-button').forEach((button) => {
      if (button.dataset.favoriteKey !== key) return;
      const saved = Boolean(favorites[key]);
      button.classList.toggle('is-saved', saved);
      button.setAttribute('aria-pressed', String(saved));
      button.setAttribute('aria-label', `${saved ? '取消收藏' : '收藏'}${button.closest('.product-card').querySelector('.product-title').textContent}`);
      button.textContent = saved ? '♥' : '♡';
    });
    return;
  }
  const quick = event.target.closest('[data-quick]');
  if (!quick || !messages.contains(quick) || input.disabled) return;
  const preference = latestMemory?.preferences || {};
  const category = preference.category || '桌面好物';
  const hasSavedPreference = Object.entries(preference).some(([field, value]) => field !== 'memoryTags' && value !== null && value !== undefined && value !== '');
  const hasRecommendations = Boolean(currentConversation()?.messages?.some((entry) => entry.role === 'assistant' && entry.result?.items?.length));
  const prompts = {
    browse: `我只想逛逛，推荐一些${category}给我看看`,
    similar: hasRecommendations ? `我想看和刚才推荐相似风格的${category}` : (hasSavedPreference ? `请按你记住的偏好推荐一些${category}` : '我想找日系风格的桌面好物'),
    cheaper: hasRecommendations ? `我想看价格更便宜一点的${category}` : '我想找100元以内的日系桌面好物',
    replace: hasRecommendations ? `请换一批${category}推荐给我` : '请推荐另一批日系桌面好物'
  };
  if (prompts[quick.dataset.quick]) sendMessage(prompts[quick.dataset.quick]);
});

const forgetInstructions = { style: '忘记风格', category: '忘记品类', scene: '忘记场景', maxPrice: '忘记预算' };
function handleForget(event) {
  if (input.disabled) return;
  const field = event.target.closest('[data-forget-field]')?.dataset.forgetField;
  if (field && forgetInstructions[field]) sendMessage(forgetInstructions[field]);
  else if (event.target.closest('[data-forget-all]')) sendMessage('忘记所有记忆');
}
document.querySelector('.memory-section').addEventListener('click', handleForget);
document.querySelector('#mobileMemory').addEventListener('click', handleForget);

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (text) sendMessage(text);
});

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 90)}px`;
});

function startNewChat() {
  requestToken += 1;
  sessionId = `demo-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
  localStorage.setItem(sessionStorageKey, sessionId);
  clearConversationView();
  showWelcome();
  renderRecent();
  input.disabled = false;
  document.querySelector('.send-control').disabled = false;
  setMemoryActionsDisabled(false);
  loadingRow.hidden = true;
  document.querySelector('.conversation').scrollTo({ top: 0, behavior: 'smooth' });
}

newChat.addEventListener('click', startNewChat);
mobileNewChat.addEventListener('click', startNewChat);

memoryToggle.addEventListener('click', () => {
  const collapsed = memoryRail.classList.toggle('is-collapsed');
  appShell.classList.toggle('memory-collapsed', collapsed);
  memoryToggle.setAttribute('aria-expanded', String(!collapsed));
  memoryToggle.setAttribute('aria-label', collapsed ? '展开记忆栏' : '折叠记忆栏');
  memoryToggle.innerHTML = `<i data-lucide="${collapsed ? 'panel-right-open' : 'panel-right-close'}"></i>`;
  globalThis.lucide?.createIcons();
});

const savedCurrentConversation = currentConversation();
if (savedCurrentConversation?.messages?.length) openConversation(sessionId);
else {
  updateMemory(latestMemory?.preferences);
  showWelcome();
  renderRecent();
}
globalThis.lucide?.createIcons();
