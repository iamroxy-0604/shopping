const form = document.querySelector('#resolveForm');
const input = document.querySelector('#urlInput');
const submit = document.querySelector('#submitButton');
const output = document.querySelector('#output');
const dialogRoot = document.querySelector('#dialogRoot');
let current = null;
let returnFocus = null;

function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (letter) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[letter])); }
function safeUrl(value) { try { const url = new URL(String(value || '')); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } }
function label(type) { return ({ video: '视频', image: '图文', article: '文章', unknown: '链接' })[type] || '链接'; }
function issueText(issue) {
  return ({ navigation_rejected: '平台拒绝读取详情，已保留能够取得的内容。', login_required: '详情需要登录后读取。',
    fetch_failed: '网页暂时无法访问。', video_unavailable: '已识别视频，但未取得可播放文件。',
    official_embed: '已取得官方播放器入口；播放由原平台提供。',
    landing_page: '这是平台首页，不是单条内容。请粘贴包含视频 BV 号或帖子编号的完整链接。',
    content_unavailable: '原平台显示页面不存在或链接已失效，请检查完整链接。',
    opencli_missing: '小红书读取组件尚未安装。', metadata_only: '只取得页面基础信息。' })[issue] || '部分内容无法读取，可打开原链接查看。';
}
function coverMarkup(record, className) {
  const cover = safeUrl(record.cover);
  if (!cover) return className === 'result-cover' ? '<span class="no-cover">没有取得封面</span>' : '';
  return `<img src="${esc(cover)}" alt="${esc(record.title)}的封面" referrerpolicy="no-referrer" onerror="this.hidden=true;this.insertAdjacentHTML('afterend','<span class=&quot;no-cover&quot;>封面无法显示</span>')">`;
}
function stateRow(name, available) { return `<div class="state-row"><span class="state-dot${available ? ' yes' : ''}"></span>${esc(name)}${available ? '已取得' : '未取得'}</div>`; }
function showRecord(record) {
  current = record;
  output.className = '';
  const readPath = record.readBy?.length ? record.readBy.join(' → ') : '未能读取页面';
  const canOpen = record.issue !== 'landing_page';
  output.innerHTML = `<div class="result-wrap"><button class="result-card" id="openCard" type="button" ${canOpen ? '' : 'disabled'} aria-label="查看${esc(label(record.contentType))}内容：${esc(record.title)}"><span class="result-cover">${coverMarkup(record, 'result-cover')}<span class="type-badge">${esc(label(record.contentType))}</span></span><span class="result-card-body"><strong>${esc(record.title)}</strong><small>${esc(record.source.platform)}</small></span></button><div class="result-notes"><h3>读取结果</h3><p>${record.status === 'complete' ? '内容已整理成可展开的卡片。' : issueText(record.issue)}</p>${stateRow('文字', record.availability.text)}${stateRow('封面地址', record.availability.cover)}${stateRow(record.embed ? '官方播放器入口' : '视频文件', record.embed ? record.availability.embed : record.availability.video)}<div class="read-path">读取方式：${esc(readPath)}</div>${canOpen ? '<span class="open-hint">点击卡片查看详情 ↗</span>' : ''}</div></div>`;
}
function openDetail() {
  if (!current) return;
  returnFocus = document.activeElement;
  const record = current;
  const video = safeUrl(record.video);
  const source = safeUrl(record.source.url);
  const gallery = (record.images || []).filter((url) => safeUrl(url) && url !== record.cover).slice(0, 11);
  const embed = safeUrl(record.embed);
  const media = video ? `<video controls preload="metadata"${record.cover ? ` poster="${esc(safeUrl(record.cover))}"` : ''} src="${esc(video)}" onerror="this.hidden=true;document.getElementById('videoError').hidden=false"></video><div class="notice" id="videoError" hidden>视频无法在浏览器中播放，请打开原链接。</div>`
    : embed ? `<iframe class="embed-player" src="${esc(embed)}" title="${esc(record.title)}的官方播放器" referrerpolicy="no-referrer" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe>`
    : record.cover ? `<img class="modal-cover" src="${esc(safeUrl(record.cover))}" alt="${esc(record.title)}的封面" referrerpolicy="no-referrer" onerror="this.hidden=true">` : '';
  const videoNotice = record.contentType === 'video' && !video ? `<div class="notice">${embed ? '此处嵌入原平台播放器；若播放受限，请打开原链接。' : '识别为视频内容，但未取得可播放文件。可以查看原链接。'}</div>` : '';
  dialogRoot.innerHTML = `<div class="modal-backdrop" id="backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="detailTitle"><div class="modal-head"><span>${esc(record.source.platform)} / ${esc(label(record.contentType))}</span><button id="closeDetail" type="button" aria-label="关闭详情">×</button></div><div class="modal-content">${media}${videoNotice}<h2 id="detailTitle">${esc(record.title)}</h2><p class="modal-source">${esc(record.source.platform)} · ${record.status === 'complete' ? '内容已读取' : '部分内容可用'}</p>${record.body ? `<section class="modal-section"><h3>读取到的正文</h3><p>${esc(record.body)}</p></section>` : record.description ? `<section class="modal-section"><h3>页面摘要</h3><p>${esc(record.description)}</p></section>` : '<section class="modal-section"><div class="notice">正文暂未取得；这里没有补写原帖内容。</div></section>'}${gallery.length ? `<section class="modal-section"><h3>其他图片</h3><div class="gallery">${gallery.map((url) => `<img src="${esc(safeUrl(url))}" alt="帖子图片" referrerpolicy="no-referrer" loading="lazy" onerror="this.hidden=true">`).join('')}</div></section>` : ''}<div class="modal-actions">${source ? `<a class="source-link" href="${esc(source)}" target="_blank" rel="noopener noreferrer">打开原链接 <span aria-hidden="true">↗</span></a>` : ''}</div></div></section></div>`;
  document.body.style.overflow = 'hidden';
  document.querySelector('#closeDetail').focus();
}
function closeDetail() {
  dialogRoot.innerHTML = '';
  document.body.style.overflow = '';
  returnFocus?.focus();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = input.value.trim();
  if (!url) return;
  current = null;
  submit.disabled = true;
  submit.querySelector('span:first-child').textContent = '正在读取链接…';
  output.className = 'output-empty busy';
  output.innerHTML = '<span class="empty-symbol" aria-hidden="true">▧</span><strong>正在整理内容</strong><p>读取标题、文字与可用媒体，请稍候。</p>';
  try {
    const response = await fetch('/api/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
    const result = await response.json();
    if (!result.ok) throw new Error(result.message || '链接无法处理。');
    showRecord(result.record);
  } catch (error) {
    output.className = '';
    output.innerHTML = `<div class="error-box"><strong>没有生成卡片</strong><p>${esc(error.message)}</p></div>`;
  } finally {
    submit.disabled = false;
    submit.querySelector('span:first-child').textContent = '生成内容卡片';
  }
});
output.addEventListener('click', (event) => { if (event.target.closest('#openCard')) openDetail(); });
dialogRoot.addEventListener('click', (event) => { if (event.target.id === 'backdrop' || event.target.closest('#closeDetail')) closeDetail(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && dialogRoot.firstChild) closeDetail(); });
