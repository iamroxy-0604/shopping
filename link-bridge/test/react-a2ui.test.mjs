import test from 'node:test';
import assert from 'node:assert/strict';
import { composeReactA2ui, SHIGUANG_CATALOG_ID } from '../src/react-a2ui.mjs';

const base = {
  id: 'record-1',
  source: { platform: '小红书', url: 'https://www.xiaohongshu.com/explore/1' },
  title: '充电宝实际体验', author: '数码用户', description: '日常通勤使用记录',
  cover: 'https://example.com/cover.jpg', images: ['https://example.com/cover.jpg', 'https://example.com/2.jpg'],
  contentType: 'image', engagement: 36000,
};

test('React composer targets the custom Shiguang catalog', () => {
  const result = composeReactA2ui(base, 'preview');
  assert.equal(result.ok, true);
  assert.equal(result.catalogId, SHIGUANG_CATALOG_ID);
  assert.equal(result.component, 'ExperiencePreview');
  assert.equal(result.messages[0].createSurface.catalogId, SHIGUANG_CATALOG_ID);
});

test('React composer selects source-aware detail components', () => {
  assert.equal(composeReactA2ui(base, 'detail').component, 'ImageExperienceDetail');
  assert.equal(composeReactA2ui({ ...base, source: { platform: 'B站', url: 'https://www.bilibili.com/video/BV1' }, contentType: 'video' }, 'detail').component, 'VideoExperienceDetail');
  assert.equal(composeReactA2ui({ ...base, source: { platform: '知乎', url: 'https://www.zhihu.com/question/1' }, contentType: 'article' }, 'detail').component, 'ArticleExperienceDetail');
});

test('React composer accepts a validated LLM component plan', () => {
  const result = composeReactA2ui(base, 'detail', {
    component: 'ArticleExperienceDetail',
    displayTitle: '精炼后的标题',
    displayBody: '只保留与商品决策相关的真实内容。',
    showCover: false,
  });
  assert.equal(result.component, 'ArticleExperienceDetail');
  assert.equal(result.messages[1].updateComponents.components[0].component, 'ArticleExperienceDetail');
  assert.equal(result.messages[2].updateDataModel.value.title, '精炼后的标题');
  assert.equal(result.messages[2].updateDataModel.value.body, '只保留与商品决策相关的真实内容。');
  assert.equal(result.messages[2].updateDataModel.value.cover, '');
  assert.deepEqual(result.messages[2].updateDataModel.value.images, []);
});

test('React composer validates input and keeps actions declarative', () => {
  assert.equal(composeReactA2ui({}, 'preview').ok, false);
  const result = composeReactA2ui(base, 'detail');
  const root = result.messages[1].updateComponents.components[0];
  assert.equal(root.onOpenSource.event.name, 'open_source');
  assert.equal(root.onOpenSource.event.context.sourceUrl, base.source.url);
});

test('generic web pages use a truthful author fallback', () => {
  const result = composeReactA2ui({ ...base, author: '', source: { platform: 'mui.com', url: 'https://mui.com/material-ui/' } }, 'preview');
  assert.equal(result.messages[2].updateDataModel.value.author, '网页内容');
});

