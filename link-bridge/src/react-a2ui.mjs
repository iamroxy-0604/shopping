export const SHIGUANG_CATALOG_ID = 'https://shiguang.local/a2ui/catalogs/content-v1.json';
const VERSION = 'v0.9.1';

function clean(value, limit = 1200) {
  return typeof value === 'string' ? value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function media(value) {
  if (typeof value === 'string' && value.startsWith('/api/content/media/')) return value;
  return safeUrl(value);
}

function platformOf(record) {
  return clean(record?.source?.platform, 40) || (() => { try { return new URL(record?.source?.url).hostname; } catch { return '来源网页'; } })();
}

function formatOf(record) {
  const platform = platformOf(record);
  if (record?.contentType === 'video' || platform.includes('B站') || platform.includes('bilibili')) return 'video';
  if (record?.contentType === 'article' || platform.includes('知乎')) return 'article';
  return 'image';
}

function engagement(value) {
  const count = Number(value || 0);
  if (!count) return '';
  return count >= 10000 ? `${(count / 10000).toFixed(count >= 100000 ? 0 : 1)}万` : String(count);
}

function commonData(record) {
  const sourceUrl = safeUrl(record?.source?.url);
  const images = [...new Set((Array.isArray(record?.images) ? record.images : []).map(media).filter(Boolean))].slice(0, 8);
  return {
    platform: platformOf(record),
    author: clean(record?.author, 48) || '真实用户',
    title: clean(record?.title, 180) || '未取得标题',
    body: clean(record?.body || record?.description, 700),
    excerpt: clean(record?.description || record?.body, 86),
    cover: media(record?.cover) || images[0] || '',
    images,
    video: media(record?.video),
    duration: clean(record?.duration, 16),
    engagement: engagement(record?.engagement),
    sourceUrl,
    format: formatOf(record),
  };
}

export function composeReactA2ui(record, mode = 'preview') {
  if (!record || typeof record !== 'object' || !['preview', 'detail'].includes(mode)) {
    return { ok: false, code: 'invalid_compose_input', message: '界面编排参数不正确。' };
  }
  const data = commonData(record);
  if (!data.sourceUrl) return { ok: false, code: 'invalid_compose_input', message: '记录缺少有效原链接。' };
  const surfaceId = `shiguang-${mode}-${String(record.id || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '-').slice(-48)}`;
  let component = 'ExperiencePreview';
  const props = mode === 'preview'
    ? {
        platform: { path: '/platform' }, author: { path: '/author' }, title: { path: '/title' }, excerpt: { path: '/excerpt' },
        cover: { path: '/cover' }, duration: { path: '/duration' }, engagement: { path: '/engagement' }, format: { path: '/format' },
        onOpen: { event: { name: 'open_detail', context: { recordId: String(record.id || '') } } },
      }
    : {
        platform: { path: '/platform' }, author: { path: '/author' }, title: { path: '/title' }, body: { path: '/body' },
        cover: { path: '/cover' }, duration: { path: '/duration' }, engagement: { path: '/engagement' }, sourceUrl: { path: '/sourceUrl' },
        images: data.images, onOpenSource: { event: { name: 'open_source', context: { sourceUrl: data.sourceUrl } } },
      };

  if (mode === 'detail') {
    if (!data.cover && !data.video && !data.body) {
      component = 'MediaUnavailable';
      Object.assign(props, { message: '当前链接没有可展示的媒体或正文，可前往原站继续查看。' });
    } else if (data.format === 'video') {
      component = 'VideoExperienceDetail';
      props.video = { path: '/video' };
    } else if (data.format === 'article') component = 'ArticleExperienceDetail';
    else component = 'ImageExperienceDetail';
  }

  const messages = [
    { version: VERSION, createSurface: { surfaceId, catalogId: SHIGUANG_CATALOG_ID } },
    { version: VERSION, updateComponents: { surfaceId, components: [{ id: 'root', component, ...props }] } },
    { version: VERSION, updateDataModel: { surfaceId, value: data } },
  ];
  return { ok: true, protocol: VERSION, catalogId: SHIGUANG_CATALOG_ID, surfaceId, component, mode, sourceUrl: data.sourceUrl, messages };
}

