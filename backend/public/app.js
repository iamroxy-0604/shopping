const $ = (selector) => document.querySelector(selector);
const conversation = $('#conversation');
const input = $('#messageInput');
const overlay = $('#overlay');
const storageKey = 'shiguang-flow-conversations-v1';
const currentKey = 'shiguang-flow-current-v1';
const userKey = 'shiguang-flow-user-v1';
const userId = localStorage.getItem(userKey) || `user-${crypto.randomUUID()}`;
localStorage.setItem(userKey, userId);
const saved = (() => { try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { return {}; } })();
let sessions = saved;
let sessionId = localStorage.getItem(currentKey) || `session-${crypto.randomUUID()}`;
let pending = null;
let busy = false;
let stage = 'idle';
let task = null;
let products = [];
let abortController = null;
let selectedAnswer = '';
let activeRecord = sessions[sessionId] || { title: '新对话', messages: [], updatedAt: '' };
const phases = ['分析需求', '补充问卷', '搜索商品', '筛选整理'];

function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function safeUrl(value) { try { const u = new URL(String(value || '')); return ['https:', 'http:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } }
function money(value) { return Number.isFinite(Number(value)) && value !== null && value !== '' ? `¥${Number(value).toLocaleString('zh-CN')}` : '价格待确认'; }
function save() { activeRecord.updatedAt = new Date().toISOString(); sessions[sessionId] = activeRecord; localStorage.setItem(storageKey, JSON.stringify(sessions)); localStorage.setItem(currentKey, sessionId); }
function icon(name, extra = '') { return `<i class="ph ph-${name}${extra ? ` ${extra}` : ''}"></i>`; }
function scrollBottom() { conversation.scrollTop = conversation.scrollHeight; }
function log(role, content) { activeRecord.messages.push({ role, content }); if (role === 'user' && activeRecord.title === '新对话') activeRecord.title = String(content).slice(0, 25); save(); }
function userMarkup(text) { return `<div class="user-row fade-in"><div class="user-bubble">${esc(text)}</div></div>`; }
function taskMarkup(state = stage) {
  if (state === 'idle') return '';
  const completed = state === 'complete';
  const label = completed ? '任务完成' : '正在执行任务中…';
  if (completed) {
    const detail = Object.entries(task?.answers || {}).map(([key, value]) => `<div class="answer-item"><b>${esc(questionLabels[key] || key)}</b><span>${esc(value)}</span></div>`).join('');
    return `<button type="button" class="complete-card" data-action="toggleComplete" aria-expanded="false"><span class="check">${icon('check')}</span><span>任务完成</span>${icon('caret-down', 'chevron')}</button><div class="complete-details" hidden>${detail || '已整理本轮需求与商品'}</div>`;
  }
  const taskRows = phases.map((name, i) => {
      const active = (state === 'processing' && i === 0) || (state === 'question' && i === 1) || (state === 'searching' && i === 2);
      const done = state === 'question' ? i === 0 : state === 'searching' ? i < 2 : false;
      return `<div class="task-row ${active ? 'no-pill' : ''}">${icon(active ? 'spinner-gap' : done ? 'check' : 'circle', active ? 'running' : '')}<span>${esc(name)}${active ? ' · 进行中' : done ? ' · 已完成' : ''}</span></div>`;
    }).join('');
  return `<section class="task-card fade-in"><div class="task-title"><span class="task-icon">${icon(completed ? 'check-circle' : 'sparkle')}</span><span>${label}</span></div>${taskRows}</section>`;
}
const questionLabels = { category: '想看的品类', use: '主要用途', scene: '使用场景', priority: '最在意的体验', budget: '预算', detail: '还想确认的细节' };
function questionMarkup(question) {
  if (!question) return '';
  const step = Number(question.step) || 1;
  const total = Number(question.total) || 4;
  return `<section class="question-card fade-in" data-question-card><div class="question-top"><strong>${step}/${total}</strong><span>选一个最接近的，也可以自己补充</span><button class="close" type="button" data-action="dismiss" aria-label="关闭问卷">${icon('x')}</button></div><h2>${esc(question.title)}</h2><div class="options" role="radiogroup" aria-label="${esc(question.title)}">${(question.options || []).map((option) => `<label class="option"><input type="radio" name="questionChoice" value="${esc(option)}"><span>${esc(option)}</span></label>`).join('')}<label class="option"><input type="radio" name="questionChoice" value="__custom__"><span>自己补充</span></label></div><input class="custom-input" id="customAnswer" placeholder="写下更具体的要求" aria-label="自定义要求" hidden><div class="question-actions"><span class="left-placeholder"></span><button type="button" class="primary" data-action="next">${step === total ? '完成，帮我挑选' : '下一题'}</button></div></section>`;
}
function productMarkup(item, index) {
  const image = safeUrl(item.imageUrl || item.media?.images?.[0]?.url);
  const link = safeUrl(item.promotionUrl || item.source?.url);
  return `<article class="product-card"><div>${image ? `<img src="${esc(image)}" alt="${esc(item.title)}" loading="lazy">` : '<div class="image-placeholder">暂无商品图片</div>'}</div><div class="product-content"><h4>${esc(item.title)}</h4><div class="product-tags"><span>第${index + 1}款</span><span>${esc(typeof item.source === 'object' ? item.source.name || '商品来源' : item.source || '商品来源')}</span></div><div class="product-bottom"><span class="price">${money(item.price)}</span>${link ? `<a class="product-open" href="${esc(link)}" target="_blank" rel="noopener noreferrer" aria-label="查看第${index + 1}款商品">${icon('arrow-up-right')}</a>` : ''}</div><small class="demo-label">实际成交价以商品页为准</small></div></article>`;
}
function resultMarkup(result) {
  const items = (result.items || []).slice(0, 3);
  products = items;
  task = result.task || task;
  const summary = String(result.summary || '').trim();
  const lead = String(result.message || '').trim();
  if (!items.length) return `${taskMarkup('complete')}<article class="result-article"><p>${esc(lead || '这轮还没找到合适的商品，可以补充条件再试。')}</p></article>`;
  const recommendations = items.map((item, i) => `<h3>第${i + 1}款 · ${esc(item.title.length > 20 ? `${item.title.slice(0, 20)}…` : item.title)}</h3>${productMarkup(item, i)}<p class="recommendation">${esc(item.recommendation || '先核对商品详情，再判断是否适合自己。')}</p>`).join('');
  const rows = items.map((item, i) => `<tr><td>第${i + 1}款</td><td>${money(item.price)}</td><td>${esc((item.matchReasons || []).slice(0, 2).join('；') || '请核对商品信息')}</td></tr>`).join('');
  return `<section class="fade-in">${taskMarkup('complete')}<article class="result-article"><p>${esc(lead)}</p>${summary ? `<p>${esc(summary)}</p>` : ''}<h2>这几款怎么选</h2>${recommendations}<button type="button" class="list-button" data-action="products">${icon('list-bullets')} 商品列表</button><h2>快速对照</h2><table><thead><tr><th>方案</th><th>标价</th><th>已知依据</th></tr></thead><tbody>${rows}</tbody></table><p>这些推荐基于商品接口提供的标题、价格和有限属性；尺寸、成分、材质、功效及实时到手价，请在原平台详情页核对。</p><p>还想怎么调整？告诉我预算、使用场景或更在意的一点，我会接着帮你看。</p></article></section>`;
}
function renderEntry(entry, index) {
  if (entry.role === 'user') return userMarkup(entry.content);
  const result = entry.content || {};
  if (result.type === 'question' && result.question) {
    const answered = activeRecord.messages.slice(index + 1).some((next) => next.role === 'user');
    return answered ? '' : `<div class="assistant-intro">${esc(result.message || '')}</div>${taskMarkup('question')}${questionMarkup(result.question)}`;
  }
  if (result.type === 'results') return resultMarkup(result);
  return `<article class="result-article"><p>${esc(result.message || result.error?.message || '这轮暂时没有结果。')}</p></article>`;
}
function render() {
  if (!activeRecord.messages.length) {
    conversation.innerHTML = `<section class="welcome-flow"><span class="welcome-symbol">${icon('sparkle')}</span><h1>好物，慢慢挑。</h1><p>告诉我你想买什么，我会先问几个真正有用的问题，再一起找到适合你的选择。</p><div class="welcome-prompts"><button data-prompt="适合军训的防晒霜">适合军训的防晒霜</button><button data-prompt="想找一盏日系桌面台灯">日系桌面台灯</button><button data-prompt="我想买一个餐桌">挑一张餐桌</button></div></section>`;
  } else {
    conversation.innerHTML = activeRecord.messages.map(renderEntry).join('') + (busy ? taskMarkup(stage) : '');
    const latest = [...activeRecord.messages].reverse().find((entry) => entry.role === 'assistant');
    pending = latest?.content?.question || null;
  }
  const latestResult = !busy && activeRecord.messages.at(-1)?.content?.type === 'results'
    ? [...conversation.querySelectorAll('.complete-card')].at(-1) : null;
  if (latestResult) latestResult.scrollIntoView({ block: 'start' });
  else scrollBottom();
}
function setBusy(value, nextStage = 'processing') {
  busy = value; stage = nextStage; input.disabled = value; $('#sendButton').disabled = value;
  $('#sendButton').innerHTML = icon(value ? 'stop-fill' : 'arrow-up');
  render();
}
async function stream(message, answer, signal) {
  const response = await fetch('/api/chat/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, userId, message, answer }), signal });
  if (!response.ok || !response.body) throw new Error('服务暂时不可用');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let result = null;
  while (true) {
    const { value, done } = await reader.read(); buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    for (const chunk of buffer.split('\n\n').slice(0, -1)) {
      const type = chunk.match(/^event:\s*(.+)$/m)?.[1]; const line = chunk.match(/^data:\s*(.+)$/m)?.[1]; if (!line) continue;
      let data; try { data = JSON.parse(line); } catch { continue; }
      if (type === 'phase') { stage = data.id === 'search' || data.id === 'rank' ? 'searching' : 'processing'; render(); }
      if (type === 'result') result = data;
      if (type === 'error') throw new Error(data.error?.message || data.message || '请求失败');
    }
    buffer = buffer.split('\n\n').at(-1) || '';
    if (done) break;
  }
  if (!result) throw new Error('服务端没有返回结果');
  return result;
}
async function send(message, answer = null) {
  if (!message || busy) return;
  pending = null; selectedAnswer = '';
  log('user', message); input.value = ''; setBusy(true);
  abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 55000);
  try {
    const result = await stream(message, answer, abortController.signal);
    task = result.task || task; stage = result.type === 'question' ? 'question' : 'complete';
    log('assistant', result);
  } catch (error) {
    log('assistant', { type: 'error', message: error.name === 'AbortError' ? '等待超时，请稍后重试。' : `暂时没能完成：${error.message}` });
  } finally { clearTimeout(timeout); abortController = null; setBusy(false, stage); input.focus(); }
}
function openOverlay(content) { overlay.innerHTML = `<div class="scrim" data-action="close"></div>${content}`; }
function closeOverlay() { overlay.innerHTML = ''; }
function menu() {
  const history = Object.entries(sessions).filter(([, record]) => record.messages?.length).sort((a, b) => String(b[1].updatedAt).localeCompare(String(a[1].updatedAt)));
  openOverlay(`<aside class="side-panel" aria-label="菜单"><div class="side-head"><span>拾光</span><button type="button" data-action="close" aria-label="关闭菜单">${icon('x')}</button></div><button type="button" class="new-chat" data-action="new">${icon('plus')} 新对话</button><p class="side-label">历史对话</p>${history.map(([id, record]) => `<button type="button" class="stage-link" data-session="${esc(id)}">${icon('chat-circle')} ${esc(record.title)}</button>`).join('') || '<p class="side-note-inline">还没有历史对话</p>'}<p class="side-note">你的对话保存在当前浏览器；商品与价格以原平台为准。</p></aside>`);
}
function drawer() { openOverlay(`<section class="drawer" role="dialog" aria-modal="true" aria-label="商品列表"><div class="drawer-head"><h2>商品列表</h2><button type="button" data-action="close" aria-label="关闭商品列表">${icon('x')}</button></div>${products.map((item, index) => { const image = safeUrl(item.imageUrl); const link = safeUrl(item.promotionUrl); return `<div class="drawer-item">${image ? `<img src="${esc(image)}" alt="${esc(item.title)}">` : ''}<div><strong>第${index + 1}款 · ${esc(item.title)}</strong><small>${esc(item.recommendation || '')}</small><em>${money(item.price)}</em>${link ? `<a class="drawer-link" href="${esc(link)}" target="_blank" rel="noopener noreferrer">查看原商品 ${icon('arrow-up-right')}</a>` : ''}</div></div>`; }).join('')}</section>`); }

$('#composer').addEventListener('submit', (event) => { event.preventDefault(); send(input.value.trim()); });
$('#menuButton').addEventListener('click', menu);
$('#jumpBottom').addEventListener('click', scrollBottom);
conversation.addEventListener('scroll', () => { $('#jumpBottom').hidden = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 200; });
conversation.addEventListener('change', (event) => {
  if (event.target.name !== 'questionChoice') return;
  selectedAnswer = event.target.value;
  $('#customAnswer').hidden = selectedAnswer !== '__custom__';
  conversation.querySelectorAll('.option').forEach((option) => option.classList.toggle('selected', option.querySelector('input')?.checked));
  if (selectedAnswer === '__custom__') $('#customAnswer').focus();
});
conversation.addEventListener('click', (event) => {
  const prompt = event.target.closest('[data-prompt]'); if (prompt) send(prompt.dataset.prompt);
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'products') drawer();
  if (action === 'toggleComplete') { const button = event.target.closest('.complete-card'); const details = button?.nextElementSibling; if (details) { details.hidden = !details.hidden; button.setAttribute('aria-expanded', String(!details.hidden)); } }
  if (action === 'dismiss') { conversation.querySelector('[data-question-card]')?.remove(); pending = null; }
  if (action === 'next' && pending) {
    const choice = selectedAnswer === '__custom__' ? $('#customAnswer').value.trim() : selectedAnswer;
    if (!choice) { conversation.querySelector('.question-card h2')?.classList.add('needs-answer'); return; }
    send(choice, { questionId: pending.id, value: choice });
  }
});
overlay.addEventListener('click', (event) => {
  const id = event.target.closest('[data-session]')?.dataset.session;
  if (id && sessions[id]) { sessionId = id; activeRecord = sessions[id]; save(); closeOverlay(); render(); return; }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'close') closeOverlay();
  if (action === 'new') { sessionId = `session-${crypto.randomUUID()}`; activeRecord = { title: '新对话', messages: [], updatedAt: '' }; pending = null; task = null; products = []; save(); closeOverlay(); render(); }
});
$('#addButton').addEventListener('click', () => { input.focus(); });
$('#clock').textContent = new Date().toLocaleTimeString('zh-CN', { hour: 'numeric', minute: '2-digit', hour12: false });
render();
