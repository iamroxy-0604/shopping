import { buildFallbackPlan, validatePlanAgainstRecord } from './detail-plan.mjs';

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
  const platform = platformOf(record);
  const genericWebPage = /\./.test(platform) && !/(?:小红书|知乎|B站|bilibili|YouTube|微博)/i.test(platform);
  const evidenceIds = new Set((Array.isArray(record?.evidence) ? record.evidence : []).map((item) => clean(item?.id, 80)));
  return {
    platform,
    author: clean(record?.author, 48) || (genericWebPage ? '网页内容' : '真实用户'),
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
    products: (Array.isArray(record?.products) ? record.products : []).slice(0, 5).map((item) => ({ name: clean(item?.name, 100), model: clean(item?.model, 80), image: media(item?.image), price: clean(item?.price, 40), matchStatus: clean(item?.matchStatus, 40), url: safeUrl(item?.url) })).filter((item) => item.name),
    analysis: {
      takeaways: (Array.isArray(record?.analysis?.takeaways) ? record.analysis.takeaways : []).slice(0, 4).map((item) => ({ text: clean(item?.text, 180), sentiment: ['positive', 'negative', 'neutral'].includes(item?.sentiment) ? item.sentiment : 'neutral', evidenceId: clean(item?.evidenceId, 80) })).filter((item) => item.text),
      pros: (Array.isArray(record?.analysis?.pros) ? record.analysis.pros : []).slice(0, 4).map((item) => clean(item?.text || item, 150)).filter(Boolean),
      cons: (Array.isArray(record?.analysis?.cons) ? record.analysis.cons : []).slice(0, 4).map((item) => clean(item?.text || item, 150)).filter(Boolean),
      metrics: (Array.isArray(record?.analysis?.metrics) ? record.analysis.metrics : []).slice(0, 6).map((item) => ({ label: clean(item?.label, 60), value: clean(item?.value, 60), evidenceId: clean(item?.evidenceId, 80) })).filter((item) => item.label && item.value && evidenceIds.has(item.evidenceId)),
      buyingAdvice: record?.analysis?.buyingAdvice && typeof record.analysis.buyingAdvice === 'object' ? { verdict: clean(record.analysis.buyingAdvice.verdict, 180), reasons: (record.analysis.buyingAdvice.reasons || []).slice(0, 4).map((item) => clean(item, 120)), notFor: (record.analysis.buyingAdvice.notFor || []).slice(0, 3).map((item) => clean(item, 120)) } : null,
      checklist: (Array.isArray(record?.analysis?.checklist) ? record.analysis.checklist : []).slice(0, 5).map((item) => clean(item, 120)).filter(Boolean),
    },
    evidence: (Array.isArray(record?.evidence) ? record.evidence : []).slice(0, 12).map((item) => ({ id: clean(item?.id, 80), text: clean(item?.text, 300), locator: clean(item?.locator, 80), sourceType: clean(item?.sourceType, 40) })).filter((item) => item.id && item.text),
  };
}

export function buildDetailComponentTree(record, plan, data = commonData(record)) {
  const checked = validatePlanAgainstRecord(plan, { ...record, ...data });
  const nodes = [{ id: 'root', component: 'DetailStack', density: checked.theme.density, children: checked.sections.map((item) => item.id) }];
  for (const item of checked.sections) {
    const bind = (name) => ({ path: `/${name}` });
    const props = { id: item.id, component: item.component, variant: item.variant };
    switch (item.component) {
      case 'SourceHeader': Object.assign(props, { platform: bind('platform'), author: bind('author'), title: bind('title'), engagement: bind('engagement') }); break;
      case 'HeroMedia': Object.assign(props, { title: bind('title'), cover: bind('cover'), video: bind('video'), images: data.images, duration: bind('duration') }); break;
      case 'ContentSummary': Object.assign(props, { title: bind('title'), body: bind('body') }); break;
      case 'KeyTakeaways': props.items = data.analysis.takeaways; break;
      case 'ProsCons': Object.assign(props, { pros: data.analysis.pros, cons: data.analysis.cons }); break;
      case 'TestMetrics': props.items = data.analysis.metrics; break;
      case 'ProductMention': props.value = data.products[0]; break;
      case 'ProductComparison': props.items = data.products; break;
      case 'BuyingAdvice': props.value = data.analysis.buyingAdvice; break;
      case 'EvidenceList': props.items = data.evidence; break;
      case 'DecisionChecklist': props.items = data.analysis.checklist; break;
      case 'SourceActions': Object.assign(props, { sourceUrl: bind('sourceUrl'), onOpenSource: { event: { name: 'open_source', context: { sourceUrl: data.sourceUrl } } } }); break;
    }
    nodes.push(props);
  }
  return nodes;
}

export function composeReactA2ui(record, mode = 'preview', plan = null) {
  if (!record || typeof record !== 'object' || !['preview', 'detail'].includes(mode)) {
    return { ok: false, code: 'invalid_compose_input', message: '界面编排参数不正确。' };
  }
  const data = commonData(record);
  if (mode === 'detail' && !plan?.component) {
    if (!data.sourceUrl) return { ok: false, code: 'invalid_compose_input', message: '记录缺少有效原链接。' };
    let checked;
    try { checked = validatePlanAgainstRecord(plan || buildFallbackPlan(record), { ...record, ...data }); }
    catch { checked = validatePlanAgainstRecord(buildFallbackPlan(record), { ...record, ...data }); }
    if (checked.content?.displayTitle) data.title = clean(checked.content.displayTitle, 180);
    if (checked.content?.displaySummary) data.body = clean(checked.content.displaySummary, 700);
    if (checked.content?.showCover === false) { data.cover = ''; data.images = []; }
    const surfaceId = `shiguang-detail-${String(record.id || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '-').slice(-48)}`;
    if (!checked.sections.length) {
      const legacy = composeReactA2ui(record, mode, { component: 'MediaUnavailable' });
      return legacy;
    }
    const components = buildDetailComponentTree(record, checked, data);
    const messages = [
      { version: VERSION, createSurface: { surfaceId, catalogId: SHIGUANG_CATALOG_ID } },
      { version: VERSION, updateComponents: { surfaceId, components } },
      { version: VERSION, updateDataModel: { surfaceId, value: data } },
    ];
    return { ok: true, protocol: VERSION, catalogId: SHIGUANG_CATALOG_ID, surfaceId, component: 'DetailStack', sectionCount: checked.sections.length, mode, sourceUrl: data.sourceUrl, messages };
  }
  if (mode === 'detail' && plan) {
    if (plan.displayTitle) data.title = clean(plan.displayTitle, 180);
    if (plan.displayBody) data.body = clean(plan.displayBody, 700);
    if (plan.showCover === false) {
      data.cover = '';
      data.images = [];
    }
  }
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

    const plannedComponent = plan?.component;
    if (['VideoExperienceDetail', 'ImageExperienceDetail', 'ArticleExperienceDetail', 'MediaUnavailable'].includes(plannedComponent)) {
      component = plannedComponent;
      if (component === 'VideoExperienceDetail') props.video = { path: '/video' };
      if (component === 'MediaUnavailable') {
        Object.assign(props, { message: '当前链接没有足够的可展示内容，可前往原站继续查看。' });
      }
    }
  }

  const messages = [
    { version: VERSION, createSurface: { surfaceId, catalogId: SHIGUANG_CATALOG_ID } },
    { version: VERSION, updateComponents: { surfaceId, components: [{ id: 'root', component, ...props }] } },
    { version: VERSION, updateDataModel: { surfaceId, value: data } },
  ];
  return { ok: true, protocol: VERSION, catalogId: SHIGUANG_CATALOG_ID, surfaceId, component, mode, sourceUrl: data.sourceUrl, messages };
}

