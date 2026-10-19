const VERSION = 'v0.9.1';
const CATALOG = 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json';
const SURFACE = 'link-preview';

function cleanText(value, limit = 1600) {
  return typeof value === 'string'
    ? value.replace(/<[^>]*>/g, ' ').replace(/[\u200b-\u200f\ufeff]/g, '').replace(/\\([\\`*_{}\[\]()#+\-.!>])/g, '$1').replace(/\s+/g, ' ').trim().slice(0, limit)
    : '';
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function mediaUrl(value) {
  if (typeof value === 'string' && /^\/api\/content\/media\/[a-zA-Z0-9]+\/[a-zA-Z0-9]+_[1-9][0-9]*\.(?:jpg|png|webp|mp4)$/.test(value)) return value;
  return safeUrl(value);
}

export function composeA2ui(record, mode = 'overview', design = {}) {
  if (!record || typeof record !== 'object' || !['overview', 'detail', 'preview'].includes(mode)) {
    return { ok: false, code: 'invalid_compose_input', message: '界面编排参数不正确。' };
  }
  const sourceUrl = safeUrl(record.source?.url);
  if (!sourceUrl) return { ok: false, code: 'invalid_compose_input', message: '记录缺少有效的原链接。' };

  const source = new URL(sourceUrl);
  const platform = cleanText(record.source?.platform, 80) || source.hostname;
  const isLandingPage = ['/', '/index.html'].includes(source.pathname);
  const isSearchPage = record.issue === 'search_results_page';
  const title = isSearchPage ? '这是小红书搜索结果页' : isLandingPage ? '平台首页链接' : cleanText(record.title, 240) || '未取得标题';
  const rawBody = isSearchPage ? cleanText(record.body, 240) : isLandingPage ? '' : cleanText(record.body || record.description, mode === 'detail' ? 260 : 96);
  const body = rawBody === title ? '' : rawBody;
  const cover = isSearchPage || isLandingPage ? '' : mediaUrl(record.cover);
  const video = mediaUrl(record.video);
  const images = isSearchPage || isLandingPage ? [] : [...new Set((Array.isArray(record.images) ? record.images : []).map(mediaUrl).filter(Boolean))].slice(0, mode === 'detail' ? 8 : 1);
  const contentType = isSearchPage || isLandingPage ? 'unknown' : ['video', 'image', 'article'].includes(record.contentType) ? record.contentType : 'unknown';
  const state = isSearchPage || isLandingPage ? 'partial' : record.status === 'unavailable' ? 'unavailable' : record.status === 'complete' ? 'complete' : 'partial';
  const surfaceId = `${SURFACE}-${mode}-${String(record.id || source.pathname).replace(/[^a-zA-Z0-9_-]/g, '-').slice(-48) || 'content'}`;
  const components = [];
  const add = (id, component, props) => { components.push({ id, component, ...props }); return id; };
  const bound = (name) => ({ path: `/${name}` });
  const cardChildren = [];
  const requestedLayout = ['article', 'image', 'video'].includes(design?.layout) ? design.layout : '';
  const textFirst = requestedLayout === 'article' || platform.includes('知乎');

  if (mode === 'preview') {
    const articlePreview = platform.includes('知乎') || contentType === 'article';
    if (cover && !articlePreview) cardChildren.push(add('preview-cover', 'Image', { url: bound('cover'), description: bound('imageDescription'), fit: 'cover', variant: 'largeFeature' }));
    if (articlePreview) cardChildren.push(add('preview-kicker', 'Text', { text: `${platform} · 深度图文`, variant: 'caption' }));
    cardChildren.push(add('preview-title', 'Text', { text: bound('title'), variant: 'h5' }));
    cardChildren.push(add('preview-meta', 'Text', { text: bound('previewMeta'), variant: 'caption' }));
    add('preview-content', 'Column', { children: cardChildren });
    add('preview-card', 'Card', { child: 'preview-content' });
    add('root', 'Column', { children: ['preview-card'] });
    const data = {
      title: cleanText(title, 44), cover, imageDescription: `${title}的封面`,
      previewExcerpt: cleanText(body, 52),
      previewMeta: `${platform} · ${cleanText(record.author, 36) || (contentType === 'video' ? '视频测评' : '真实体验')}${Number(record.engagement) ? ` · ${Number(record.engagement) >= 10000 ? `${(Number(record.engagement) / 10000).toFixed(Number(record.engagement) >= 100000 ? 0 : 1)}万` : Number(record.engagement)}` : ''}`
    };
    return { ok: true, protocol: VERSION, catalogId: CATALOG, mode, surfaceId, sourceUrl,
      layout: contentType === 'video' ? 'video-card' : platform.includes('知乎') ? 'article-card' : 'image-card',
      designSource: design?.source === 'ai' ? 'ai' : 'rule',
      messages: [
        { version: VERSION, createSurface: { surfaceId, catalogId: CATALOG } },
        { version: VERSION, updateComponents: { surfaceId, components } },
        { version: VERSION, updateDataModel: { surfaceId, value: data } }
      ] };
  }

  if (textFirst) {
    cardChildren.push(add('title', 'Text', { text: bound('title'), variant: 'h3' }));
    if (body) cardChildren.push(add('body', 'Text', { text: bound('body'), variant: 'body' }));
  }

  if (contentType === 'video' && video) {
    cardChildren.push(add('primary-video', 'Video', { url: bound('video') }));
  } else if (cover) {
    cardChildren.push(add('primary-image', 'Image', { url: bound('cover'), description: bound('imageDescription'), fit: 'cover', variant: mode === 'detail' ? 'header' : 'largeFeature' }));
  }

  if (!textFirst) {
    cardChildren.push(add('title', 'Text', { text: bound('title'), variant: 'h3' }));
    if (body) cardChildren.push(add('body', 'Text', { text: bound('body'), variant: 'body' }));
  }

  if (mode === 'detail' && images.length > 1) {
    cardChildren.push(add('gallery-label', 'Text', { text: '其他图片', variant: 'h5' }));
    const galleryIds = images.filter((url) => url !== cover).map((url, index) => add(`gallery-${index}`, 'Image', { url, description: `内容图片 ${index + 1}`, fit: 'cover', variant: 'smallFeature' }));
    if (galleryIds.length) cardChildren.push(add('gallery', 'Row', { children: galleryIds }));
  }

  const mediaNotice = isSearchPage
    ? ''
    : isLandingPage
    ? '这是平台首页链接；没有把首页推荐流当作单条内容展示。请粘贴一条具体笔记或视频链接。'
    : contentType === 'video' && !video
    ? safeUrl(record.embed) ? '此视频有原平台播放器入口；A2UI 基础 Video 组件不能直接播放该网页，请打开原链接。' : '识别为视频，但未取得可播放文件。请打开原链接。'
    : !cover && !video && state !== 'complete' ? '没有取得可展示的媒体。' : '';
  if (mediaNotice) cardChildren.push(add('media-notice', 'Text', { text: mediaNotice, variant: 'caption' }));
  if (state === 'unavailable' && !isSearchPage) cardChildren.push(add('unavailable-notice', 'Text', { text: '链接内容当前无法读取；仍可尝试打开原链接。', variant: 'caption' }));

  add('card-content', 'Column', { children: cardChildren });
  add('content-card', 'Card', { child: 'card-content' });
  add('root', 'Column', { children: ['content-card'] });

  const data = {
    source: `${platform} · ${isSearchPage ? '搜索结果页' : isLandingPage ? '首页链接' : contentType === 'video' ? '视频' : contentType === 'image' ? '图文' : '网页'} · ${isSearchPage ? '需要具体笔记链接' : state === 'complete' ? '内容已读取' : state === 'partial' ? '部分内容可用' : '内容无法读取'}`,
    title, body, cover, video, imageDescription: `${title}的封面`
  };
  const messages = [
    { version: VERSION, createSurface: { surfaceId, catalogId: CATALOG } },
    { version: VERSION, updateComponents: { surfaceId, components } },
    { version: VERSION, updateDataModel: { surfaceId, value: data } }
  ];
  return { ok: true, protocol: VERSION, catalogId: CATALOG, mode, surfaceId, sourceUrl, layout: isSearchPage ? 'search-page' : isLandingPage ? 'landing-page' : contentType === 'video' && video ? 'video' : contentType === 'video' ? 'video-fallback' : textFirst ? 'article' : contentType === 'image' ? 'image' : state === 'unavailable' ? 'unavailable' : 'article', designSource: design?.source === 'ai' ? 'ai' : 'rule', messages };
}
