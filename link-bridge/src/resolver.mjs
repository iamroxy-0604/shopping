import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { runOpenCli } from './opencli.mjs';

const MAX_HTML = 1024 * 1024;
const text = (value, max = 6000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const first = (...values) => values.find((value) => typeof value === 'string' && value.trim()) || '';
const XHS_HOSTS = new Set(['xiaohongshu.com', 'www.xiaohongshu.com', 'xhslink.com', 'www.xhslink.com']);
const onHost = (host, domain) => host === domain || host.endsWith(`.${domain}`);

export function openCliRoute(url) {
  const host = url.hostname.toLowerCase();
  if (XHS_HOSTS.has(host) && /^\/search(?:_result)?\/?$/i.test(url.pathname)) return { platform: '小红书', kind: 'xiaohongshu-search', type: 'unknown', args: null };
  if (XHS_HOSTS.has(host)) return { platform: '小红书', kind: 'xiaohongshu', type: 'unknown', args: ['xiaohongshu', 'note', url.href, '-f', 'json'] };
  if (onHost(host, 'bilibili.com')) {
    const id = url.pathname.match(/^\/video\/(BV[a-zA-Z0-9]+)/i)?.[1];
    if (id) return { platform: 'B站', kind: 'bilibili', type: 'video', args: ['bilibili', 'video', id, '-f', 'json'], embed: `https://player.bilibili.com/player.html?bvid=${id}` };
  }
  if (onHost(host, 'youtube.com') || host === 'youtu.be') {
    const id = host === 'youtu.be' ? url.pathname.slice(1).split('/')[0]
      : url.pathname.match(/^\/(?:shorts|live)\/([\w-]+)/)?.[1] || url.searchParams.get('v');
    if (id && /^[\w-]{11}$/.test(id)) return { platform: 'YouTube', kind: 'youtube', type: 'video', args: ['youtube', 'video', url.href, '-f', 'json'], embed: `https://www.youtube-nocookie.com/embed/${id}` };
  }
  if (onHost(host, 'weibo.com') || host === 'm.weibo.cn') {
    const id = url.pathname.match(/^\/(?:\d+\/)?(?:detail|status)\/([a-zA-Z0-9]+)\/?$/)?.[1]
      || url.pathname.match(/^\/[a-zA-Z0-9]+\/([a-zA-Z0-9]+)\/?$/)?.[1];
    if (id) return { platform: '微博', kind: 'weibo', type: 'unknown', args: ['weibo', 'post', id, '-f', 'json'] };
  }
  if (onHost(host, 'zhihu.com')) {
    const answer = url.pathname.match(/^\/question\/\d+\/answer\/(\d+)/)?.[1];
    if (answer) return { platform: '知乎', kind: 'zhihu', type: 'article', args: ['zhihu', 'answer-detail', answer, '-f', 'json'] };
    const question = url.pathname.match(/^\/question\/(\d+)/)?.[1];
    if (question) return { platform: '知乎', kind: 'zhihu', type: 'article', args: ['zhihu', 'question', question, '-f', 'json'] };
  }
  return { platform: host, kind: 'generic', type: 'unknown', args: null };
}

function privateHost(host) {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local')) return true;
  if (isIP(name) === 6) return name === '::1' || name === '::' || name.startsWith('fc') || name.startsWith('fd') || name.startsWith('fe80') || name.startsWith('::ffff:');
  if (isIP(name) === 4) {
    const [a, b] = name.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return false;
}

export function parseInputUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || privateHost(url.hostname)) return null;
    if (url.port && !['80', '443'].includes(url.port)) return null;
    return url;
  } catch { return null; }
}

function publicMediaUrl(value, base) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value, base);
    if (url.protocol === 'http:' && (url.hostname === 'hdslb.com' || url.hostname.endsWith('.hdslb.com'))) url.protocol = 'https:';
    return parseInputUrl(url.href)?.href || '';
  } catch { return ''; }
}

function isXhsNoteImage(value) {
  try {
    const url = new URL(value);
    return /(?:^|\.)xhscdn\.com$/i.test(url.hostname) && /(?:notes?_pre_post|note_pre_post_uhdr)/i.test(url.pathname);
  } catch { return false; }
}

function isXhsAvatar(value) {
  try { const url = new URL(value); return /sns-avatar/i.test(url.hostname) || /\/avatar\//i.test(url.pathname); }
  catch { return false; }
}

function isXhsBrandAsset(value) {
  try { const url = new URL(value); return /(^|\.)picasso-static\.xiaohongshu\.com$/i.test(url.hostname) && /\/fe-platform\//i.test(url.pathname); }
  catch { return false; }
}

async function checkPublicDns(url, lookupImpl) {
  if (isIP(url.hostname)) return !privateHost(url.hostname);
  const addresses = await lookupImpl(url.hostname, { all: true });
  return addresses.length > 0 && addresses.every((row) => !privateHost(row.address));
}

async function fetchPage(startUrl, { fetchImpl, lookupImpl }) {
  let url = startUrl;
  for (let redirect = 0; redirect < 4; redirect += 1) {
    try { if (!await checkPublicDns(url, lookupImpl)) return { ok: false, code: 'unsafe_target' }; }
    catch { return { ok: false, code: 'dns_failed' }; }
    let response;
    try {
      response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(12000), headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'user-agent': 'Mozilla/5.0 LinkBridge/1.0' } });
    } catch { return { ok: false, code: 'fetch_failed' }; }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) return { ok: false, code: 'invalid_redirect' };
      let next;
      try { next = parseInputUrl(new URL(location, url).href); }
      catch { return { ok: false, code: 'invalid_redirect' }; }
      if (!next) return { ok: false, code: 'unsafe_redirect' };
      url = next;
      continue;
    }
    if (!response.ok) return { ok: false, code: `http_${response.status}` };
    const contentType = response.headers.get('content-type') || '';
    if (/^video\/(mp4|webm)/i.test(contentType)) {
      await response.body?.cancel();
      return { ok: true, finalUrl: url.href, videoFile: true };
    }
    if (!/html|text\/plain/i.test(contentType)) {
      await response.body?.cancel();
      return { ok: false, code: 'unsupported_media' };
    }
    const reader = response.body?.getReader();
    if (!reader) return { ok: false, code: 'empty_response' };
    const chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_HTML) { await reader.cancel(); return { ok: false, code: 'page_too_large' }; }
      chunks.push(value);
    }
    return { ok: true, finalUrl: url.href, html: Buffer.concat(chunks).toString('utf8') };
  }
  return { ok: false, code: 'too_many_redirects' };
}

function decodeHtml(value) {
  return text(value).replace(/&#(x[0-9a-f]+|\d+);?/gi, (_, code) => {
    const point = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
  }).replace(/&(?:amp|quot|apos|lt|gt|nbsp);/gi, (entity) => ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' }[entity.toLowerCase()] || entity));
}

function attributes(tag) {
  const result = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) result[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4]);
  return result;
}

function plainHtml(value) {
  return decodeHtml(value.replace(/<(?:script|style|svg|nav|header|footer|aside|form|button|select|noscript|template|dialog)\b[^>]*>[\s\S]*?<\/\s*(?:script|style|svg|nav|header|footer|aside|form|button|select|noscript|template|dialog)\s*>/gi, ' ')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/[\t ]+/g, ' ').replace(/\n\s*\n+/g, '\n')).slice(0, 6000);
}

export function parseHtmlMetadata(html, baseUrl) {
  const meta = new Map();
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attr = attributes(tag);
    const name = (attr.property || attr.name || '').toLowerCase();
    if (name && attr.content && !meta.has(name)) meta.set(name, attr.content);
  }
  const title = first(meta.get('og:title'), meta.get('twitter:title'), decodeHtml(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''));
  const description = first(meta.get('og:description'), meta.get('description'), meta.get('twitter:description'));
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1]
    || html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] || '';
  const simpleBody = !article ? html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] || '' : '';
  const plainBody = simpleBody ? plainHtml(simpleBody) : '';
  const body = article ? plainHtml(article) : plainBody.length <= 2500 ? plainBody : '';
  const articleImage = article.match(/<img\b[^>]*>/i)?.[0];
  const imageAttributes = articleImage ? attributes(articleImage) : {};
  const cover = publicMediaUrl(first(meta.get('og:image'), meta.get('twitter:image'), imageAttributes.src, imageAttributes['data-src']), baseUrl);
  const videoTag = html.match(/<video\b[^>]*>/i)?.[0];
  const sourceTag = html.match(/<source\b[^>]*>/i)?.[0];
  const rawVideo = first(meta.get('og:video:secure_url'), meta.get('og:video'), meta.get('twitter:player:stream'),
    videoTag ? attributes(videoTag).src : '', sourceTag ? attributes(sourceTag).src : '');
  const video = publicMediaUrl(rawVideo, baseUrl);
  const directVideo = /\.(?:mp4|webm)(?:$|[?#])/i.test(video) ? video : '';
  const videoType = /video/i.test(first(meta.get('og:type'), meta.get('twitter:card'))) || Boolean(video || videoTag);
  return { title: text(title, 240), description: text(description, 1600), body, cover, video: directVideo, videoType };
}

function cliFields(data) {
  const value = data?.data?.note || data?.note || data?.data || data;
  if (Array.isArray(value)) return Object.fromEntries(value.filter((row) => typeof row?.field === 'string').map((row) => [row.field, row.value]));
  return value && typeof value === 'object' ? value : {};
}

function cliText(value) {
  if (typeof value !== 'string') return '';
  return /<\/?[a-z][^>]*>/i.test(value) ? plainHtml(value) : text(value);
}

function normalizeCli(data, base) {
  const fields = cliFields(data);
  const title = cliText(first(fields.title, fields.name, fields.question_title));
  const body = cliText(first(fields.content, fields.description, fields.desc, fields.text, fields.summary, fields.excerpt));
  const cover = publicMediaUrl(first(fields.cover, fields.thumbnail, fields.thumbnail_url, fields.pic, fields.image), base);
  const images = Array.isArray(fields.images) ? fields.images : Array.isArray(fields.pics) ? fields.pics : [];
  return { title, body, cover, images, video: fields.video, note_type: fields.note_type, type: fields.type };
}

function unavailablePage(data, route) {
  if (route.kind !== 'xiaohongshu') return false;
  return /(?:访问的页面不见了|页面不存在|笔记不存在|内容已删除|页面已失效)/.test(`${data.title || ''} ${data.body || ''}`);
}

const BROWSER_EXTRACT = `(() => {
  const meta = key => document.querySelector('meta[property="' + key + '"],meta[name="' + key + '"]')?.content || '';
  const answer = /zhihu\\.com$/.test(location.hostname) && /\\/answer\\//.test(location.pathname)
    ? document.querySelector('.RichContent-inner') : null;
  const contentRoot = answer || document.querySelector('#detail-desc, .note-content, article, [role="main"], main');
  const clone = contentRoot?.cloneNode(true);
  clone?.querySelectorAll('script,style,svg,nav,header,footer,aside,form,button,select,noscript,template,dialog,[aria-hidden="true"],pre code').forEach(node => node.remove());
  const rawText = clone?.innerText || '';
  const seen = new Set();
  const desc = rawText.split(/\\n+/).map(line => line.replace(/\\s+/g, ' ').trim()).filter(line => {
    if (!line || seen.has(line)) return false;
    seen.add(line);
    return true;
  }).join('\\n');
  const video = document.querySelector('video')?.currentSrc || document.querySelector('video source')?.src || '';
  return { title: document.querySelector('#detail-title, h1')?.innerText || meta('og:title') || document.title,
    body: desc.slice(0, 6000), description: meta('og:description') || meta('description'), cover: meta('og:image') || meta('twitter:image'), video,
    videoType: !!document.querySelector('video') || /video/i.test(meta('og:type')),
    images: Array.from(document.querySelectorAll('#noteContainer img, .swiper-slide img, article img, main img')).filter(img => (img.naturalWidth || img.width || 0) >= 240 && (img.naturalHeight || img.height || 0) >= 160).map(img => img.currentSrc || img.src).filter(Boolean).slice(0, 12) };
})()`;

async function browserRead(url, cli) {
  const session = `link-bridge-${randomUUID().slice(0, 8)}`;
  try {
    const opened = await cli(['browser', session, 'open', url], 18000);
    if (!opened.ok) return opened;
    const result = await cli(['browser', session, 'eval', BROWSER_EXTRACT], 12000);
    return result.ok && result.data && typeof result.data === 'object' ? result : { ok: false, code: result.code || 'browser_empty' };
  } finally {
    await cli(['browser', session, 'close'], 5000);
  }
}

export async function resolveLink(input, { fetchImpl = fetch, lookupImpl = lookup, cli = runOpenCli } = {}) {
  const parsed = parseInputUrl(input);
  if (!parsed) return { ok: false, code: 'invalid_url', message: '请输入公开的 http 或 https 链接。' };
  try {
    if (!await checkPublicDns(parsed, lookupImpl)) return { ok: false, code: 'unsafe_target', message: '不能读取本机或内网链接。' };
  } catch { return { ok: false, code: 'dns_failed', message: '链接域名暂时无法解析。' }; }
  const route = openCliRoute(parsed);
  if (route.kind === 'xiaohongshu-search') {
    return { ok: true, record: {
      id: `link:${randomUUID()}`, source: { url: parsed.href, platform: route.platform },
      contentType: 'unknown', title: '这是小红书搜索结果页',
      body: '搜索结果页包含多条笔记，不能作为单条内容生成卡片。请点开一篇具体笔记，再复制它的分享链接。',
      description: '', cover: '', images: [], video: '', embed: '', readBy: [], status: 'unavailable',
      availability: { text: false, cover: false, video: false, embed: false }, issue: 'search_results_page'
    } };
  }
  const problems = [];
  const readBy = [];
  let cliData = {};
  let browserData = {};
  let pageData = {};
  let finalUrl = parsed.href;

  if (route.args) {
    const result = await cli(route.args, 25000);
    if (result.ok) {
      cliData = normalizeCli(result.data, parsed.href);
      if (first(cliData.title, cliData.body, cliData.cover, typeof cliData.video === 'string' ? cliData.video : '')) readBy.push(`OpenCLI · ${route.platform}适配器`);
    } else problems.push(result.code);
  }

  const useBrowser = route.kind === 'xiaohongshu' || route.kind === 'generic'
    || !first(cliData.title, cliData.body, cliData.cover);
  if (useBrowser && !/\.(?:mp4|webm)(?:$|[?#])/i.test(parsed.pathname + parsed.search)) {
    const browser = await browserRead(parsed.href, cli);
    if (browser.ok) {
      if (unavailablePage(browser.data, route)) problems.push('content_unavailable');
      else {
        browserData = browser.data;
        if (first(browserData.title, browserData.body, browserData.cover, browserData.video)) readBy.push('OpenCLI · Browser Bridge');
      }
    } else problems.push(browser.code);
  }

  const needsPage = !first(cliData.title, browserData.title) || !first(cliData.body, browserData.body)
    || !first(cliData.cover, browserData.cover) || (!route.embed && route.kind === 'generic');
  if (needsPage) {
    const page = await fetchPage(parsed, { fetchImpl, lookupImpl });
    if (page.ok) {
      pageData = page.videoFile ? { title: decodeURIComponent(new URL(page.finalUrl).pathname.split('/').at(-1) || '视频'), video: page.finalUrl, videoType: true } : parseHtmlMetadata(page.html, page.finalUrl);
      if (unavailablePage(pageData, route)) { pageData = {}; problems.push('content_unavailable'); }
      else {
        finalUrl = page.finalUrl;
        if (first(pageData.title, pageData.body, pageData.description, pageData.cover, pageData.video)) readBy.push('公开网页');
      }
    } else problems.push(page.code);
  }

  const source = parseInputUrl(finalUrl);
  const base = source?.href || parsed.href;
  const title = text(first(cliData.title, browserData.title, pageData.title), 240);
  const body = text(first(cliData.body, browserData.body, pageData.body), 6000);
  const description = text(first(browserData.description, pageData.description), 1600);
  let cover = publicMediaUrl(first(cliData.cover, browserData.cover, pageData.cover), base);
  const rawImages = [cover, ...(Array.isArray(browserData.images) ? browserData.images : []), ...(Array.isArray(cliData.images) ? cliData.images : [])];
  let images = [...new Set(rawImages.map((item) => publicMediaUrl(typeof item === 'string' ? item : first(item?.url, item?.src), base)).filter(Boolean))].slice(0, 12);
  if (route.kind === 'xiaohongshu') {
    const noteImages = [...new Set([cover, ...images].filter(isXhsNoteImage))];
    images = [...new Set([...noteImages, ...images.filter((image) => !isXhsAvatar(image) && !isXhsBrandAsset(image))])].slice(0, 12);
    if (noteImages.length) cover = noteImages[0];
    else if (isXhsBrandAsset(cover) || isXhsAvatar(cover)) cover = images[0] || '';
  }
  const rawVideo = publicMediaUrl(first(browserData.video, typeof cliData.video === 'string' ? cliData.video : cliData.video?.url, pageData.video), base);
  const video = /\.(?:mp4|webm)(?:$|[?#])/i.test(rawVideo) ? rawVideo : '';
  const finalRoute = openCliRoute(source || parsed);
  const embed = finalRoute.embed || route.embed || '';
  const videoType = Boolean(route.type === 'video' || finalRoute.type === 'video' || browserData.videoType || pageData.videoType || cliData.type === 'video' || cliData.note_type === 'video' || video || embed);
  const contentType = videoType ? 'video'
    : route.kind === 'generic' && (body || description) ? 'article'
      : images.length ? 'image' : title || body || description ? 'article' : 'unknown';
  const status = videoType && !video ? title || body || description || images.length || embed ? 'partial' : 'unavailable'
    : body || video ? 'complete' : title || description || images.length ? 'partial' : 'unavailable';
  const record = {
    id: `link:${randomUUID()}`, source: { url: base, platform: route.platform === parsed.hostname ? finalRoute.platform : route.platform },
    contentType, title: title || (status === 'unavailable' ? '暂时无法读取此链接' : source?.hostname || parsed.hostname),
    body: route.kind === 'bilibili' && !cliData.body && description ? description.split(/,?\s*视频播放量/)[0] : body,
    description, cover: cover || images[0] || '', images, video, embed,
    readBy,
    status, availability: { text: Boolean(body || description), cover: Boolean(cover || images.length), video: Boolean(video), embed: Boolean(embed) },
    issue: embed && !video ? 'official_embed' : videoType && !video ? 'video_unavailable' : status === 'complete' ? ''
      : problems.includes('content_unavailable') ? 'content_unavailable' : problems.find(Boolean) || 'metadata_only'
  };
  return { ok: true, record };
}
