export const SECTION_VARIANTS = Object.freeze({
  SourceHeader: ['default'], HeroMedia: ['video', 'gallery', 'image', 'poster'],
  KeyTakeaways: ['default'], ContentSummary: ['default'], ProsCons: ['balanced', 'compact', 'evidence-first'],
  TestMetrics: ['grid'], ProductMention: ['default'], ProductComparison: ['table', 'cards', 'compact'],
  BuyingAdvice: ['default'], EvidenceList: ['default'], SourceActions: ['default'],
  DecisionChecklist: ['default'],
});

const section = (id, component, variant = 'default') => ({ id, component, variant });

export function buildFallbackPlan(record) {
  const hasText = Boolean(record?.body || record?.description);
  const hasMedia = Boolean(record?.video || record?.cover || record?.images?.length);
  if (!hasText && !hasMedia) return { planVersion: '1', reason: '内容不可用', sections: [] };
  const sections = [section('source', 'SourceHeader')];
  if (hasMedia) sections.push(section('hero', 'HeroMedia', record?.video ? 'video' : record?.contentType === 'video' ? 'poster' : record?.images?.length > 1 ? 'gallery' : 'image'));
  if (record?.analysis?.takeaways?.length) sections.push(section('takeaways', 'KeyTakeaways'));
  if (hasText) sections.push(section('summary', 'ContentSummary'));
  if (record?.analysis?.metrics?.some((item) => record?.evidence?.some((source) => source.id === item.evidenceId))) sections.push(section('metrics', 'TestMetrics', 'grid'));
  if (record?.analysis?.pros?.length || record?.analysis?.cons?.length) sections.push(section('pros-cons', 'ProsCons', 'balanced'));
  if (record?.products?.length >= 2) sections.push(section('comparison', 'ProductComparison', 'cards'));
  else if (record?.products?.length === 1) sections.push(section('product', 'ProductMention'));
  if (record?.analysis?.buyingAdvice) sections.push(section('advice', 'BuyingAdvice'));
  if (record?.evidence?.length && sections.length < 7) sections.push(section('evidence', 'EvidenceList'));
  sections.push(section('actions', 'SourceActions'));
  for (const component of ['ContentSummary', 'EvidenceList', 'ProductMention', 'ProsCons', 'HeroMedia']) {
    if (sections.length <= 8) break;
    const index = sections.findIndex((item) => item.component === component);
    if (index >= 0) sections.splice(index, 1);
  }
  return { planVersion: '1', reason: '按可用内容与购物证据编排', confidence: null, theme: { name: 'warm', density: 'comfortable' }, sections };
}

export function validatePlanAgainstRecord(plan, record) {
  if (!plan || plan.planVersion !== '1' || !Array.isArray(plan.sections) || (plan.sections.length < 2 && plan.sections.length !== 0) || plan.sections.length > 8) throw new Error('planner_invalid_sections');
  const ids = new Set();
  const sections = plan.sections.map((item) => {
    if (!item || typeof item.id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(item.id) || item.id === 'root' || ids.has(item.id)) throw new Error('planner_invalid_section_id');
    ids.add(item.id);
    if (!Object.hasOwn(SECTION_VARIANTS, item.component)) throw new Error('planner_invalid_component');
    if (!SECTION_VARIANTS[item.component].includes(item.variant || 'default')) throw new Error('planner_invalid_variant');
    return { id: item.id, component: item.component, variant: item.variant || 'default' };
  });
  const available = {
    HeroMedia: Boolean(record?.video || record?.cover || record?.images?.length),
    KeyTakeaways: Boolean(record?.analysis?.takeaways?.length), ContentSummary: Boolean(record?.body || record?.description),
    ProsCons: Boolean(record?.analysis?.pros?.length || record?.analysis?.cons?.length), TestMetrics: Boolean(record?.analysis?.metrics?.length && record?.analysis?.metrics?.every((item) => record?.evidence?.some((source) => source.id === item.evidenceId))),
    ProductMention: Boolean(record?.products?.length), ProductComparison: (record?.products?.length || 0) >= 2,
    BuyingAdvice: Boolean(record?.analysis?.buyingAdvice), EvidenceList: Boolean(record?.evidence?.length),
    DecisionChecklist: Boolean(record?.analysis?.checklist?.length),
  };
  if (sections.some(({ component }) => Object.hasOwn(available, component) && !available[component])) throw new Error('planner_missing_evidence');
  if (sections.length && sections.filter((item) => item.component === 'SourceActions').length !== 1) throw new Error('planner_missing_actions');
  return { planVersion: '1', reason: String(plan.reason || '').slice(0, 180), confidence: Number.isFinite(Number(plan.confidence)) ? Math.max(0, Math.min(1, Number(plan.confidence))) : null,
    theme: { name: ['warm', 'y2k', 'western', 'journal'].includes(plan.theme?.name) ? plan.theme.name : 'warm', density: plan.theme?.density === 'compact' ? 'compact' : 'comfortable' },
    content: { displayTitle: String(plan.content?.displayTitle || '').slice(0, 180), displaySummary: String(plan.content?.displaySummary || '').slice(0, 700), showCover: plan.content?.showCover !== false }, sections };
}
