const sessionStorageKey = 'immersive-shopping-session-id';
const conversationsStorageKey = 'immersive-shopping-conversations';
let sessionId = localStorage.getItem(sessionStorageKey) || `demo-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
localStorage.setItem(sessionStorageKey, sessionId);
const form = document.querySelector('#chatForm');
const input = document.querySelector('#messageInput');
const messages = document.querySelector('#messages');
const loadingRow = document.querySelector('#loadingRow');
const sampleUserMessage = document.querySelector('#sampleUserMessage');
const sampleAssistantMessage = document.querySelector('#sampleAssistantMessage');
const newChat = document.querySelector('#newChat');
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
  sampleUserMessage.hidden = true;
  sampleAssistantMessage.hidden = true;
  document.querySelector('.results-label')?.setAttribute('hidden', '');
  updateMemory({});
}

function openConversation(id) {
  const record = conversations[id];
  if (!record) return;
  sessionId = id;
  localStorage.setItem(sessionStorageKey, sessionId);
  clearConversationView();
  for (const message of record.messages || []) {
    if (message.role === 'user') appendUserMessage(message.text, false);
    if (message.role === 'assistant') appendAssistantMessage(message.result, false);
  }
  updateMemory(record.memory || {});
  renderRecent();
  document.querySelector('.conversation').scrollTo({ top: document.querySelector('.conversation').scrollHeight, behavior: 'smooth' });
}

const sampleProducts = [
  { imageUrl: '/assets/sample-lamp.jpg', title: '日式原木桌面台灯', subtitle: '暖光护眼 · 简约百搭', price: 129, source: '来自 生活好物' },
  { imageUrl: '/assets/sample-organizer.jpg', title: '原木桌面收纳盒', subtitle: '多格收纳 · 桌面更整洁', price: 89, source: '来自 家居日用' },
  { imageUrl: '/assets/sample-tray.jpg', title: '日系简约桌面托盘', subtitle: '低饱和配色 · 百搭实用', price: 59, source: '来自 生活好物' }
];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function productCard(item) {
  const image = item.imageUrl ? `<img class="product-image" src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.title)}" loading="lazy">` : '<div class="product-image" aria-label="暂无图片"></div>';
  const price = item.price == null ? '价格待确认' : `¥${Number(item.price).toFixed(0)}`;
  const reason = item.recommendation || (item.matchReasons?.length ? item.matchReasons.join(' · ') : (item.subtitle || item.categoryName || '值得看看 · 生活好物'));
  const extra = [item.suitableFor ? `适合：${item.suitableFor}` : '', item.highlight ? `亮点：${item.highlight}` : '', item.watchout ? `注意：${item.watchout}` : ''].filter(Boolean).join('<br>');
  return `<article class="product-card"><a href="${escapeHtml(item.promotionUrl || '#')}" target="_blank" rel="noreferrer">${image}<div class="product-body"><p class="product-title">${escapeHtml(item.title || '未命名商品')}</p><p class="product-subtitle">${escapeHtml(reason)}</p>${extra ? `<p class="product-extra">${escapeHtml(extra).replace(/&lt;br&gt;/g, '<br>')}</p>` : ''}<div class="product-price-row"><span class="product-price">${price}</span><span class="product-arrow">›</span></div><div class="product-source">${escapeHtml(item.source || `来自 ${item.shopName || '淘宝联盟'}`)}</div></div></a></article>`;
}

function renderProducts(items, target = messages) {
  const cards = items.slice(0, 3).map(productCard).join('');
  target.insertAdjacentHTML('beforeend', `<div class="product-grid">${cards}</div>`);
}

function appendUserMessage(text, persist = true) {
  messages.insertAdjacentHTML('beforeend', `<div class="message user-message"><div class="message-main"><div class="user-bubble">${escapeHtml(text)}</div><time>刚刚</time></div><span class="user-avatar" aria-label="用户头像"></span></div>`);
  if (persist) persistMessage({ role: 'user', text });
}

function appendAssistantMessage(result, persist = true) {
  messages.insertAdjacentHTML('beforeend', `<div class="message assistant-message"><span class="assistant-avatar" aria-label="助手头像"><i data-lucide="bot"></i></span><div class="message-main"><div class="assistant-bubble">${escapeHtml(result.message)}</div><time>刚刚</time></div></div>`);
  globalThis.lucide?.createIcons();
  if (result.items?.length) renderProducts(result.items);
  else if (result.type === 'results') messages.insertAdjacentHTML('beforeend', '<div class="empty-state">暂时没有找到合适商品，你可以换个说法或补充一下预算。</div>');
  updateMemory(result.memory?.preferences || {});
  if (persist) {
    const record = touchConversation('');
    record.memory = result.memory?.preferences || record.memory || {};
    persistMessage({ role: 'assistant', result: { message: result.message, type: result.type, items: result.items || [], memory: result.memory } });
  }
  document.querySelector('.conversation').scrollTo({ top: document.querySelector('.conversation').scrollHeight, behavior: 'smooth' });
}

function updateMemory(preferences) {
  const tags = document.querySelector('#memoryTags');
  const values = (preferences.memoryTags?.length ? preferences.memoryTags : [preferences.style, preferences.category, preferences.scene, preferences.maxPrice ? `预算 ${preferences.maxPrice} 元以内` : '']).filter(Boolean);
  if (!values.length) {
    tags.innerHTML = '';
    return;
  }
  tags.innerHTML = values.map((value) => `<button class="memory-tag">${escapeHtml(value)} <span>×</span></button>`).join('');
}

async function sendMessage(text) {
  appendUserMessage(text);
  input.value = '';
  input.style.height = 'auto';
  loadingRow.hidden = false;
  input.disabled = true;
  document.querySelector('.send-control').disabled = true;
  try {
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, message: text }) });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error?.message || '暂时没有响应');
    appendAssistantMessage(result);
  } catch (error) {
    appendAssistantMessage({ message: error.message, type: 'error', items: [] });
  } finally {
    loadingRow.hidden = true;
    input.disabled = false;
    document.querySelector('.send-control').disabled = false;
    input.focus();
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (text) sendMessage(text);
});

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 90)}px`;
});

newChat.addEventListener('click', () => {
  sessionId = `demo-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
  localStorage.setItem(sessionStorageKey, sessionId);
  clearConversationView();
  document.querySelector('.results-label')?.removeAttribute('hidden');
  renderRecent();
  document.querySelector('.conversation').scrollTo({ top: 0, behavior: 'smooth' });
});

document.querySelector('.add-memory').addEventListener('click', () => input.focus());

memoryToggle.addEventListener('click', () => {
  const collapsed = memoryRail.classList.toggle('is-collapsed');
  appShell.classList.toggle('memory-collapsed', collapsed);
  memoryToggle.setAttribute('aria-expanded', String(!collapsed));
  memoryToggle.setAttribute('aria-label', collapsed ? '展开记忆栏' : '折叠记忆栏');
  memoryToggle.innerHTML = `<i data-lucide="${collapsed ? 'chevron-right' : 'chevron-left'}"></i>`;
  globalThis.lucide?.createIcons();
});

const savedCurrentConversation = currentConversation();
if (savedCurrentConversation?.messages?.length) openConversation(sessionId);
else {
  renderProducts(sampleProducts);
  renderRecent();
}
globalThis.lucide?.createIcons();
