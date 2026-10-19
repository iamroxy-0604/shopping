import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFallbackPlan, validatePlanAgainstRecord } from '../src/detail-plan.mjs';
import { composeReactA2ui } from '../src/react-a2ui.mjs';

const evidence = [{ id: 'e1', text: '充至 80% 约 30 分钟', sourceType: 'article' }];
const record = { id: 'comparison', source: { url: 'https://example.com/review', platform: '测评站' }, contentType: 'video', title: '充电宝横评', body: '对比两款充电宝。', cover: 'https://example.com/cover.jpg',
  evidence, products: [{ name: '甲', model: 'A' }, { name: '乙', model: 'B' }], analysis: { takeaways: [{ text: '甲更轻', sentiment: 'positive', evidenceId: 'e1' }], pros: ['体积小'], cons: ['端口少'], metrics: [{ label: '充至80%', value: '30分钟', evidenceId: 'e1' }], buyingAdvice: { verdict: '适合通勤', reasons: ['体积小'], notFor: ['多设备用户'] } } };

test('fallback builds a bounded real A2UI child tree', () => {
  const result = composeReactA2ui(record, 'detail');
  assert.equal(result.ok, true);
  const nodes = result.messages[1].updateComponents.components;
  assert.equal(nodes[0].component, 'DetailStack');
  assert.ok(nodes.length >= 7 && nodes.length <= 9);
  assert.deepEqual(nodes[0].children, nodes.slice(1).map((node) => node.id));
  assert.ok(nodes.some((node) => node.component === 'ProductComparison'));
  assert.ok(nodes.some((node) => node.component === 'TestMetrics'));
  assert.ok(nodes.some((node) => node.component === 'BuyingAdvice'));
});

test('plan rejects unknown variants, duplicate ids, excess sections and unsupported evidence', () => {
  const minimal = { planVersion: '1', sections: [{ id: 'source', component: 'SourceHeader', variant: 'default' }, { id: 'actions', component: 'SourceActions', variant: 'default' }] };
  assert.throws(() => validatePlanAgainstRecord({ ...minimal, sections: [...minimal.sections, { id: 'x', component: 'HeroMedia', variant: 'javascript' }] }, record), /planner_invalid_variant/);
  assert.throws(() => validatePlanAgainstRecord({ ...minimal, sections: [minimal.sections[0], { ...minimal.sections[1], id: 'source' }] }, record), /planner_invalid_section_id/);
  assert.throws(() => validatePlanAgainstRecord({ ...minimal, sections: Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, component: 'SourceHeader', variant: 'default' })) }, record), /planner_invalid_sections/);
  assert.throws(() => validatePlanAgainstRecord({ ...minimal, sections: [{ id: 'metrics', component: 'TestMetrics', variant: 'grid' }, minimal.sections[1]] }, { ...record, evidence: [] }), /planner_missing_evidence/);
});

test('unavailable record keeps source action', () => {
  const result = composeReactA2ui({ id: 'empty', source: { url: 'https://example.com' }, title: '暂不可用' }, 'detail');
  assert.equal(result.component, 'MediaUnavailable');
  assert.equal(result.messages[1].updateComponents.components[0].onOpenSource.event.name, 'open_source');
});

test('fallback combinations differ by content and media', () => {
  const video = buildFallbackPlan(record).sections.map((item) => item.component);
  const image = buildFallbackPlan({ ...record, contentType: 'image', products: [], analysis: {} }).sections.map((item) => item.component);
  const article = buildFallbackPlan({ ...record, contentType: 'article', cover: '', products: [], analysis: {} }).sections.map((item) => item.component);
  assert.notDeepEqual(video, article);
  assert.ok(video.indexOf('HeroMedia') < video.indexOf('ContentSummary'));
  assert.ok(image.indexOf('ContentSummary') < image.indexOf('HeroMedia'));
});
