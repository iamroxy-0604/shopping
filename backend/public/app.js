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
let contentSlides = [];
let contentSlideIndex = 0;
let contentTouchStart = null;
let activeRecord = sessions[sessionId] || { title: '新对话', messages: [], updatedAt: '' };
const phases = ['分析需求', '补充问卷', '搜索商品', '筛选整理'];

function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function safeUrl(value) { if (typeof value === 'string' && /^\/api\/content\/media\/[a-zA-Z0-9]+\/[a-zA-Z0-9]+_[1-9][0-9]*\.(?:jpg|png|webp|mp4)$/.test(value)) return value; try { const u = new URL(String(value || '')); return ['https:', 'http:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } }
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
  return `<article class="product-card"><div>${image ? `<img src="${esc(image)}" alt="${esc(item.title)}" loading="lazy">` : '<div class="image-placeholder">暂无商品图片</div>'}</div><div class="product-content"><h4>${esc(item.title)}</h4><div class="product-tags"><span>第${index + 1}款</span><span>${esc(typeof item.source === 'object' ? item.source.name || '商品来源' : item.source || '商品来源')}</span></div><div class="product-bottom"><span class="price">${money(item.price)}</span>${link ? `<a class="product-open" href="${esc(link)}" target="_blank" rel="noopener noreferrer" aria-label="查看第${index + 1}款商品">${icon('arrow-up-right')}</a>` : ''}</div><small class="demo-label">实际成交价以商品页为准</small>${item.recommendation ? `<p class="product-reason">${esc(item.recommendation)}</p>` : ''}</div></article>`;
}
function productListMarkup(items) {
  return `<section class="product-list" aria-label="推荐商品"><h2>为你挑了 ${items.length} 款商品</h2>${items.map(productMarkup).join('')}</section>`;
}
function productHeroMarkup(item) {
  if (!item) return '';
  const image = safeUrl(item.imageUrl || item.media?.images?.[0]?.url);
  const link = safeUrl(item.promotionUrl || item.source?.url);
  const source = typeof item.source === 'object' ? item.source.name || item.source.platform || '商品平台' : item.source || '商品平台';
  return `<article class="hero-product"><div class="hero-product-media">${image ? `<img src="${esc(image)}" alt="${esc(item.title)}">` : '<div class="image-placeholder">暂无商品图片</div>'}</div><div class="hero-product-copy"><h2>${esc(item.title)}</h2><div class="hero-tags"><span class="source-tag">${esc(source)}</span><span>推荐首选</span><span>价格以商品页为准</span></div><div class="hero-product-foot"><strong>${money(item.price)}</strong>${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer" aria-label="查看商品">${icon('arrow-up-right')}</a>` : ''}</div></div></article>`;
}
function platformLabel(record) {
  const raw = String(record.source?.platform || record.platform || '内容来源').toLowerCase();
  if (raw.includes('xiaohongshu') || raw.includes('小红书')) return '小红书';
  if (raw.includes('bilibili') || raw.includes('b站')) return 'B站';
  if (raw.includes('zhihu') || raw.includes('知乎')) return '知乎';
  return record.source?.platform || record.platform || '网页';
}
function engagementLabel(record) {
  const value = Number(record.engagement || 0);
  if (!value) return record.contentType === 'video' || record.contentType === 'video_note' ? '视频实测' : '真实体验';
  return value >= 10000 ? `${(value / 10000).toFixed(value >= 100000 ? 0 : 1)}万` : String(value);
}
function contentMarkup(record) {
  const media = Array.isArray(record.media) ? record.media : [];
  const cover = media.find((item) => item.id === record.coverMediaId && item.type === 'image' && item.status === 'available');
  const coverUrl = safeUrl(cover?.url);
  const platform = platformLabel(record);
  const video = record.contentType === 'video' || record.contentType === 'video_note';
  return `<button type="button" class="content-card platform-${esc(platform)}" data-action="openContent" data-record-id="${esc(record.id)}" aria-label="查看内容：${esc(record.title || '未提供标题')}"><span class="a2ui-preview-host" data-a2ui-preview="${esc(record.id)}"><span class="content-cover">${coverUrl ? `<img src="${esc(coverUrl)}" alt="" loading="lazy" onerror="this.hidden=true"><span class="play-mark">${video ? icon('play-fill') : icon('article')}</span>` : `<span class="image-placeholder">${video ? '视频测评' : '文章体验'}</span>`}</span><span class="content-body"><strong>${esc(record.title || '未提供标题')}</strong></span></span><span class="content-footer"><span class="content-source-line"><b class="content-source-badge">${esc(platform)}</b><span class="content-author">${esc(record.author || '真实用户')}</span></span><span class="content-engagement">${icon('heart')} ${esc(engagementLabel(record))}</span></span></button>`;
}
function fallbackContentDrawer(record) {
  const media = Array.isArray(record.media) ? record.media : [];
  const images = media.filter((item) => item.type === 'image' && item.status === 'available' && safeUrl(item.url)).slice(0, 6);
  const video = media.find((item) => item.type === 'video' && item.status === 'available' && safeUrl(item.url));
  const sourceUrl = safeUrl(record.source?.url);
  const body = record.retrieval?.textAvailable ? String(record.body || '').slice(0, 6000) : '';
  return `<h3>${esc(record.title || '未提供标题')}</h3>${images.length ? `<div class="content-gallery">${images.map((item) => `<img src="${esc(safeUrl(item.url))}" alt="内容图片" loading="lazy" onerror="this.hidden=true">`).join('')}</div>` : ''}${video ? `<video controls preload="none" src="${esc(safeUrl(video.url))}">视频暂不可用</video>` : ''}<p>${body ? esc(body) : '正文暂不可用，请查看原链接。'}</p>${sourceUrl ? `<a href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer">查看原链接</a>` : ''}`;
}
function findContent(id) { return activeRecord.messages.flatMap((message) => Array.isArray(message.content?.contentRecords) ? message.content.contentRecords : []).find((record) => record.id === id); }
function polishDetailPresentation(presentation, record) {
  const copy = structuredClone(presentation);
  for (const message of copy?.messages || []) {
    const model = message.updateDataModel?.value;
    if (model) {
      const title = String(model.title || '').trim();
      const body = String(model.body || '').replace(/\s+/g, ' ').trim();
      const author = String(record?.author || '真实用户').trim();
      const fallback = `来自${author}的${record?.contentType === 'video' || record?.contentType === 'video_note' ? '视频实测' : '使用体验'}，可作为选购时的补充参考。`;
      model.body = body === title || !body ? fallback : body.slice(0, 130);
    }
    const components = message.updateComponents?.components;
    if (!Array.isArray(components)) continue;
    message.updateComponents.components = components
      .filter((component) => !['source', 'open-label', 'open-source'].includes(component.id))
      .map((component) => {
        if (component.id === 'root' && Array.isArray(component.children)) component.children = component.children.filter((id) => id !== 'source');
        if (component.id === 'card-content' && Array.isArray(component.children)) {
          component.children = component.children.filter((id) => id !== 'open-source');
          if (platformLabel(record) === '知乎') {
            const preferred = ['title', 'body', 'primary-image', 'gallery-label', 'gallery', 'media-notice', 'unavailable-notice'];
            component.children.sort((a, b) => preferred.indexOf(a) - preferred.indexOf(b));
          }
        }
        if (component.id === 'primary-image') component.variant = 'header';
        return component;
      });
  }
  return copy;
}
function polishPreviewPresentation(presentation, record) {
  const copy = structuredClone(presentation);
  for (const message of copy?.messages || []) {
    const model = message.updateDataModel?.value;
    if (model) {
      model.title = String(model.title || record.title || '').replace(/\s+/g, ' ').trim().slice(0, 44);
      model.previewExcerpt = String(record.body || record.description || '来自真实用户的深度图文体验。').replace(/\s+/g, ' ').trim().slice(0, 52);
      model.previewMeta = `${platformLabel(record)} · ${String(record.author || '真实用户').slice(0, 30)} · ${engagementLabel(record)}`;
    }
    const components = message.updateComponents?.components;
    if (!Array.isArray(components)) continue;
    const title = components.find((component) => component.id === 'preview-title');
    if (title) title.variant = 'h5';
    if (platformLabel(record) === '知乎') {
      if (!components.some((component) => component.id === 'preview-kicker')) components.push({ id: 'preview-kicker', component: 'Text', text: '知乎 · 深度图文', variant: 'caption' });
      if (!components.some((component) => component.id === 'preview-excerpt')) components.push({ id: 'preview-excerpt', component: 'Text', text: { path: '/previewExcerpt' }, variant: 'caption' });
      const content = components.find((component) => component.id === 'preview-content');
      if (content) content.children = ['preview-kicker', 'preview-title', 'preview-excerpt'];
    }
    const content = components.find((component) => component.id === 'preview-content');
    if (content && Array.isArray(content.children)) content.children = content.children.filter((id) => id !== 'preview-meta');
  }
  return copy;
}
function contentGroup(id) {
  const entry = activeRecord.messages.findLast((message) => Array.isArray(message.content?.contentRecords) && message.content.contentRecords.some((record) => record.id === id));
  return (entry?.content?.contentRecords || []).filter((record) => record.kind !== 'product_link');
}
function showContentSlide() {
  const record = contentSlides[contentSlideIndex];
  if (!record) return;
  const sourceUrl = safeUrl(record.source?.url);
  const layout = record.presentation?.layout || record.contentType || '网页';
  const platform = platformLabel(record);
  const format = record.contentType === 'video' || record.contentType === 'video_note' ? '视频实测' : platform === '知乎' ? '深度图文' : '真实体验';
  openOverlay(`<section class="drawer content-drawer a2ui-drawer platform-${esc(platform)}" role="dialog" aria-modal="true" aria-label="体验详情"><div class="sheet-handle"></div><div class="drawer-head"><div><small><b>${esc(platform)}</b>　${esc(record.author || '真实用户')}　·　${format}</small></div><button type="button" data-action="close" aria-label="关闭内容">${icon('x')}</button></div><div class="content-slide-nav"><button type="button" data-action="prevContent" ${contentSlideIndex === 0 ? 'disabled' : ''} aria-label="上一条内容">${icon('caret-left')}</button><span>${contentSlideIndex + 1} / ${contentSlides.length}</span><button type="button" data-action="nextContent" ${contentSlideIndex === contentSlides.length - 1 ? 'disabled' : ''} aria-label="下一条内容">${icon('caret-right')}</button></div><div class="content-slide-scroll"><div id="a2uiSurfaceHost" class="shopping-a2ui-host">${fallbackContentDrawer(record)}</div></div><div class="content-actions">${sourceUrl ? `<a href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer">${icon('arrow-square-out')} 查看原帖</a>` : ''}<button type="button" data-action="selectContent" data-record-id="${esc(record.id)}">${icon('chat-circle')}<span>问拾光<small>关于这款产品的更多问题</small></span></button></div></section>`);
  if (record.presentation && typeof window.renderShoppingA2ui === 'function') {
    const host = $('#a2uiSurfaceHost');
    window.renderShoppingA2ui(host, polishDetailPresentation(record.presentation, record), 'detail').then((ok) => {
      if (!ok && host.isConnected) host.innerHTML = fallbackContentDrawer(record);
    });
  }
}
function openContent(id) {
  contentSlides = contentGroup(id);
  contentSlideIndex = Math.max(0, contentSlides.findIndex((record) => record.id === id));
  showContentSlide();
}
function contentListMarkup(result) {
  const records = Array.isArray(result.contentRecords) ? result.contentRecords : [];
  const allowed = result.ui?.blocks?.find((block) => block.type === 'content_list')?.recordIds;
  const shown = records.filter((record) => Array.isArray(allowed) && allowed.includes(record.id));
  if (!shown.length) return result.contentStatus === 'unavailable' ? `<p class="content-status">${result.contentDiagnostics?.reason === 'bridge_unavailable' ? 'OpenCLI 浏览器扩展尚未连接，相关帖子暂不可用。' : result.contentDiagnostics?.reason === 'login_required' ? '相关帖子需登录小红书后才能读取。' : '相关帖子暂不可用。'}</p>` : '';
  const content = shown.filter((record) => record.kind !== 'product_link');
  const productLinks = shown.filter((record) => record.kind === 'product_link');
  return `<section class="content-section"><div class="experience-head"><div><h2>${result.type === 'link_content' ? '找到的链接' : '相关真实体验'}</h2><p>我帮你找到了大家的真实使用体验，看看是否符合你的需求。</p></div><span>来自真实用户的分享，仅供参考 ${icon('caret-right')}</span></div>${content.length ? `<div class="content-grid" aria-label="可滑动的内容链接">${content.map(contentMarkup).join('')}</div><div class="content-pager"><i></i><i></i><i></i><i></i></div><p class="content-hint">${icon('arrow-left')}　左右滑动查看更多真实体验　${icon('arrow-right')}</p>` : ''}${productLinks.map((record) => `<a class="product-source-link" href="${esc(safeUrl(record.source?.url))}" target="_blank" rel="noopener noreferrer">${esc(record.title)} · 查看原商品页</a>`).join('')}</section>`;
}
function aiAnalysisMarkup(result) {
  const intro = String(result.message || '').trim();
  const summary = String(result.summary || '').trim();
  const followUp = String(result.followUp || '').trim();
  if (!intro && !summary) return '';
  return `<section class="ai-analysis"><div class="ai-analysis-head"><span>${icon('sparkle')} AI 导购分析</span><small>基于本轮需求与商品资料</small></div>${intro ? `<p class="ai-analysis-intro">${esc(intro)}</p>` : ''}${summary ? `<p class="ai-analysis-summary">${esc(summary)}</p>` : ''}${followUp ? `<button type="button" data-prompt="${esc(followUp)}">${icon('chat-circle')} ${esc(followUp)}</button>` : ''}</section>`;
}
function resultMarkup(result) {
  const items = (result.items || []).slice(0, 3);
  products = items;
  task = result.task || task;
  if (!items.length) return `${taskMarkup('complete')}<article class="result-article"><p>${esc(result.message || '这轮暂时没有商品结果。')}</p>${contentListMarkup(result)}</article>`;
  if (result.narrativeSource !== 'ai' || !result.message || !result.summary || !result.followUp || items.some((item) => !item.recommendation)) {
    return '<article class="result-article"><p>导购分析尚未完成，请重试生成。</p><button type="button" class="list-button" data-action="retry-narrative">重试生成推荐</button></article>';
  }
  return `<section class="fade-in shopping-result">${taskMarkup('complete')}<article class="result-article">${productListMarkup(items)}${aiAnalysisMarkup(result)}${contentListMarkup(result)}<p class="result-caveat">商品信息与价格以原平台为准；真实体验内容仅供选购参考。</p></article></section>`;
}
function candidateMarkup(result) {
  const items = Array.isArray(result.candidateItems) ? result.candidateItems.slice(0, 3) : [];
  if (!items.length) return '';
  products = items;
  return `<section class="candidate-section shopping-result">${productListMarkup(items)}</section>`;
}
function renderEntry(entry, index) {
  if (entry.role === 'user') return userMarkup(entry.content);
  const result = entry.content || {};
  if (result.type === 'question' && result.question) {
    const answered = activeRecord.messages.slice(index + 1).some((next) => next.role === 'user');
    return answered ? `<div class="assistant-intro answered-question">${esc(result.question.title || result.message || '')}</div>` : `<div class="assistant-intro">${esc(result.message || '')}</div>${taskMarkup('question')}${questionMarkup(result.question)}`;
  }
  if (result.type === 'results') return resultMarkup(result);
  if (result.type === 'link_content') return `<article class="result-article"><p>${esc(result.message)}</p>${contentListMarkup(result)}<p class="result-caveat">这是内容来源，尚未核验为在售商品；价格和库存需另查商品页。</p></article>`;
  return `<article class="result-article"><p>${esc(result.message || result.error?.message || '这轮暂时没有结果。')}</p>${result.error?.code === 'NARRATIVE_UNAVAILABLE' ? '<button type="button" class="list-button" data-action="retry-narrative">重试生成推荐</button>' : ''}${candidateMarkup(result)}${contentListMarkup(result)}</article>`;
}
function render() {
  window.disposeShoppingA2ui?.();
  if (!activeRecord.messages.length) {
    conversation.innerHTML = `<section class="welcome-flow"><span class="welcome-symbol">${icon('sparkle')}</span><h1>好物，慢慢挑。</h1><p>告诉我你想买什么，我会先问几个真正有用的问题，再一起找到适合你的选择。</p><div class="welcome-prompts"><button data-prompt="适合军训的防晒霜">适合军训的防晒霜</button><button data-prompt="想找一盏日系桌面台灯">日系桌面台灯</button><button data-prompt="我想买一个餐桌">挑一张餐桌</button></div></section>`;
  } else {
    conversation.innerHTML = activeRecord.messages.map(renderEntry).join('') + (busy ? taskMarkup(stage) : '');
    const latest = [...activeRecord.messages].reverse().find((entry) => entry.role === 'assistant');
    pending = latest?.content?.question || null;
  }
  const latestResult = !busy && activeRecord.messages.at(-1)?.content?.type === 'results'
    ? [...conversation.querySelectorAll('.product-list')].at(-1) : null;
  if (latestResult) latestResult.scrollIntoView({ block: 'start' });
  else scrollBottom();
  queueMicrotask(hydrateA2uiPreviews);
}
function hydrateA2uiPreviews() {
  if (typeof window.renderShoppingA2ui !== 'function') return;
  document.querySelectorAll('[data-a2ui-preview]').forEach((host) => {
    const record = findContent(host.dataset.a2uiPreview);
    if (!record?.previewPresentation || host.dataset.rendered) return;
    host.dataset.rendered = 'true';
    window.renderShoppingA2ui(host, polishPreviewPresentation(record.previewPresentation, record), `preview:${record.id}`).then((ok) => {
      if (ok) host.closest('.content-card')?.classList.add('a2ui-rendered');
      else delete host.dataset.rendered;
    });
  });
}
window.addEventListener('shopping-a2ui-ready', hydrateA2uiPreviews);
function setBusy(value, nextStage = 'processing') {
  busy = value; stage = nextStage; input.disabled = value; $('#sendButton').disabled = value;
  $('#sendButton').innerHTML = icon(value ? 'stop-fill' : 'arrow-up');
  render();
}
async function stream(message, answer, signal) {
  const recordId = /想买|我要买|想找|换成|改成|重新找/.test(message) ? null : activeRecord.selectedContentId || null;
  const response = await fetch('/api/chat/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, userId, message, answer, recordId }), signal });
  if (!response.ok || !response.body) throw new Error('服务暂时不可用');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let result = null;
  while (true) {
    const { value, done } = await reader.read(); buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    for (const chunk of buffer.split('\n\n').slice(0, -1)) {
      const type = chunk.match(/^event:\s*(.+)$/m)?.[1]; const line = chunk.match(/^data:\s*(.+)$/m)?.[1]; if (!line) continue;
      let data; try { data = JSON.parse(line); } catch { continue; }
      if (type === 'phase') { stage = data.id === 'search' || data.id === 'rank' ? 'searching' : 'processing'; render(); }
      if (type === 'result') result = data;
      if (type === 'error') {
        if (data.type === 'error') result = data;
        else { const error = new Error(data.error?.message || data.message || '请求失败'); error.code = data.error?.code; throw error; }
      }
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
  const timeout = setTimeout(() => abortController.abort(), 340000);
  try {
    const result = await stream(message, answer, abortController.signal);
    if (result.type === 'link_content' && result.contentRecords?.[0]?.id) activeRecord.selectedContentId = result.contentRecords[0].id;
    task = result.task || task; stage = result.type === 'question' ? 'question' : 'complete';
    log('assistant', result);
  } catch (error) {
    log('assistant', { type: 'error', message: error.name === 'AbortError' ? '等待超时，请稍后重试。' : `暂时没能完成：${error.message}`, error: { code: error.code } });
  } finally { clearTimeout(timeout); abortController = null; setBusy(false, stage); input.focus(); }
}
function openOverlay(content) { overlay.innerHTML = `<div class="scrim" data-action="close"></div>${content}`; }
function closeOverlay() { window.disposeShoppingA2ui?.('detail'); overlay.innerHTML = ''; }
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
  if (action === 'openContent') { const id = event.target.closest('[data-record-id]')?.dataset.recordId; if (findContent(id)) openContent(id); }
  if (action === 'selectContent') { activeRecord.selectedContentId = event.target.closest('[data-record-id]')?.dataset.recordId || null; save(); input.placeholder = '继续问这篇帖子…'; input.focus(); }
  if (action === 'retry-narrative') send('重试生成推荐');
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
  if (action === 'prevContent' && contentSlideIndex > 0) { contentSlideIndex -= 1; showContentSlide(); }
  if (action === 'nextContent' && contentSlideIndex < contentSlides.length - 1) { contentSlideIndex += 1; showContentSlide(); }
  if (action === 'selectContent') { activeRecord.selectedContentId = event.target.closest('[data-record-id]')?.dataset.recordId || null; save(); closeOverlay(); input.placeholder = '继续问这篇帖子…'; input.focus(); }
  if (action === 'new') { sessionId = `session-${crypto.randomUUID()}`; activeRecord = { title: '新对话', messages: [], updatedAt: '', selectedContentId: null }; pending = null; task = null; products = []; save(); closeOverlay(); render(); }
});
overlay.addEventListener('touchstart', (event) => {
  if (!event.target.closest('.content-slide-scroll')) return;
  const touch = event.changedTouches[0];
  contentTouchStart = touch ? [touch.clientX, touch.clientY] : null;
}, { passive: true });
overlay.addEventListener('touchend', (event) => {
  if (!contentTouchStart) return;
  const touch = event.changedTouches[0];
  const dx = touch.clientX - contentTouchStart[0];
  const dy = touch.clientY - contentTouchStart[1];
  contentTouchStart = null;
  if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
  if (dx < 0 && contentSlideIndex < contentSlides.length - 1) { contentSlideIndex += 1; showContentSlide(); }
  if (dx > 0 && contentSlideIndex > 0) { contentSlideIndex -= 1; showContentSlide(); }
}, { passive: true });
$('#addButton').addEventListener('click', () => { input.focus(); });
$('#clock').textContent = new Date().toLocaleTimeString('zh-CN', { hour: 'numeric', minute: '2-digit', hour12: false });
render();
