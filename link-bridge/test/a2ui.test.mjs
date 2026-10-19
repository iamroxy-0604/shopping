import test from 'node:test';
import assert from 'node:assert/strict';
import { composeA2ui } from '../src/a2ui.mjs';
import { createServer } from '../src/server.mjs';

const base = {
  source: { url: 'https://example.com/post', platform: '示例站' },
  contentType: 'image', title: '外套使用分享', body: '实际读到的正文',
  cover: 'https://example.com/cover.jpg', images: ['https://example.com/cover.jpg', 'https://example.com/other.jpg'],
  video: '', embed: '', status: 'complete'
};

test('A2UI output uses a versioned surface and changes components by task', () => {
  const overview = composeA2ui(base, 'overview');
  const detail = composeA2ui(base, 'detail');
  assert.equal(overview.ok, true);
  assert.equal(overview.messages[0].version, 'v0.9.1');
  assert.equal(overview.messages[0].createSurface.catalogId, overview.catalogId);
  assert.equal(overview.messages[1].updateComponents.components.find((item) => item.id === 'root').component, 'Column');
  assert.equal(overview.messages[2].updateDataModel.value.title, '外套使用分享');
  assert.equal(overview.messages[2].updateDataModel.value.title.includes('\\'), false);
  assert.equal(overview.messages[2].updateDataModel.value.body.length <= 96, true);
  assert.ok(!overview.messages[1].updateComponents.components.some((item) => item.id === 'gallery'));
  assert.ok(detail.messages[1].updateComponents.components.some((item) => item.id === 'gallery'));
});

test('controlled AI layout changes component order using the same real record', () => {
  const image = composeA2ui(base, 'detail', { layout: 'image', source: 'ai' });
  const article = composeA2ui(base, 'detail', { layout: 'article', source: 'ai' });
  const children = (result) => result.messages[1].updateComponents.components.find((item) => item.id === 'card-content').children;
  assert.equal(image.designSource, 'ai');
  assert.equal(article.designSource, 'ai');
  assert.equal(children(image)[0], 'primary-image');
  assert.equal(children(article)[0], 'title');
  assert.equal(children(article)[1], 'body');
});

test('a platform homepage is not presented as a single image or article', () => {
  const result = composeA2ui({ ...base, source: { url: 'https://www.bilibili.com/', platform: 'B站' }, cover: base.cover, images: [base.cover], body: '推荐流一 推荐流二 推荐流三' });
  assert.equal(result.layout, 'landing-page');
  assert.equal(result.messages[2].updateDataModel.value.title, '平台首页链接');
  assert.equal(result.messages[2].updateDataModel.value.body, '');
  assert.ok(!result.messages[1].updateComponents.components.some((item) => item.component === 'Image'));
});

test('a Xiaohongshu search URL renders a clear request for a note link', () => {
  const result = composeA2ui({ ...base, source: { url: 'https://www.xiaohongshu.com/search_result?keyword=台灯', platform: '小红书' }, issue: 'search_results_page', title: '这是小红书搜索结果页', body: '请打开一篇具体笔记并复制链接。', cover: 'https://example.com/logo.png', status: 'unavailable' });
  assert.equal(result.layout, 'search-page');
  assert.equal(result.messages[2].updateDataModel.value.title, '这是小红书搜索结果页');
  assert.equal(result.messages[2].updateDataModel.value.cover, '');
  assert.equal(result.messages[2].updateDataModel.value.body, '请打开一篇具体笔记并复制链接。');
});

test('a video page without a playable file receives fallback UI rather than Video', () => {
  const result = composeA2ui({ ...base, contentType: 'video', video: '', embed: 'https://player.bilibili.com/player.html?bvid=BVtest', status: 'partial' });
  assert.equal(result.layout, 'video-fallback');
  assert.ok(!result.messages[1].updateComponents.components.some((item) => item.component === 'Video'));
  assert.ok(result.messages[1].updateComponents.components.some((item) => item.id === 'media-notice'));
});

test('a direct MP4 receives a Video component and bad source URLs are rejected', () => {
  const result = composeA2ui({ ...base, contentType: 'video', video: 'https://example.com/movie.mp4' });
  assert.equal(result.layout, 'video');
  assert.ok(result.messages[1].updateComponents.components.some((item) => item.component === 'Video'));
  assert.equal(composeA2ui({ ...base, source: { url: 'javascript:alert(1)' } }).ok, false);
});

test('standalone compose endpoint returns actual A2UI messages', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/compose`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ record: base, mode: 'detail' })
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.messages.length, 3);
    assert.equal(data.mode, 'detail');
  } finally { server.close(); }
});
