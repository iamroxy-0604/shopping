import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildContentQuery, discoverRelatedContent, discoverOpenWeb, normalizeXiaohongshu, signedNoteUrl, attachDownloadedMedia, cacheRemoteCover } from '../src/content/index.mjs';

const url = 'https://www.xiaohongshu.com/search_result/abc123?xsec_token=signed%2Bvalue&xsec_source=pc_search';

test('signed links keep token and reject wrong hosts or unsigned notes', () => {
  assert.equal(signedNoteUrl(url), url);
  assert.equal(signedNoteUrl('https://evil.com/search_result/abc123?xsec_token=x'), '');
  assert.equal(signedNoteUrl('https://www.xiaohongshu.com/explore/abc123'), '');
});

test('search, read, normalize and deduplicate content without inventing media', async () => {
  const calls = [];
  const runner = async (args) => {
    calls.push(args);
    if (args[1] === 'search') return { ok: true, data: [{ url, title: '桌面台灯分享', author: 'A' }, { url, title: 'duplicate' }] };
    if (args[1] === 'note') return { ok: true, data: [{ field: 'title', value: '桌面台灯分享' }, { field: 'content', value: '用了一周，桌面占地比较小。' }] };
    return { ok: false, code: 'media_unavailable' };
  };
  const result = await discoverRelatedContent({ category: '台灯', questionnaireAnswers: [{ answer: '书桌阅读' }] }, { runner });
  assert.equal(buildContentQuery({ category: '台灯', scene: '租房' }), '台灯 租房 使用体验');
  assert.equal(calls.length, 3);
  assert.equal(calls[1][2], url);
  assert.equal(result.status, 'ok');
  assert.equal(result.records[0].body, '用了一周，桌面占地比较小。');
  assert.equal(result.records[0].media.length, 0);
  assert.equal(result.records[0].presentation.protocol, 'v0.9.1');
});

test('failed read stays title-only and missing CLI remains unavailable', async () => {
  const result = await discoverRelatedContent({ category: '台灯' }, { runner: async (args) => args[1] === 'search'
    ? { ok: true, data: [{ url, title: '台灯只读到标题' }] }
    : { ok: false, code: 'login_required' } });
  assert.equal(result.status, 'partial');
  assert.equal(result.records[0].retrieval.status, 'login_required');
  assert.equal(result.records[0].body, '');
  assert.equal(result.records[0].media.length, 0);
  const missing = await discoverRelatedContent({ category: '台灯' }, { runner: async () => ({ ok: false, code: 'cli_missing' }) });
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.diagnostics.reason, 'cli_missing');
  assert.equal(normalizeXiaohongshu({ url: 'https://evil.com/x?xsec_token=x' }, {}), null);
});

test('download rows expose only files that actually exist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shopping-media-'));
  try {
    fs.mkdirSync(path.join(root, 'abc123'));
    fs.writeFileSync(path.join(root, 'abc123', 'abc123_1.jpg'), 'sample');
    const record = normalizeXiaohongshu({ url, title: '图片笔记' }, [{ field: 'content', value: '正文' }]);
    attachDownloadedMedia(record, { ok: true, data: [
      { index: 1, type: 'image', status: 'success' },
      { index: 2, type: 'video', status: 'failed' }
    ] }, root);
    assert.equal(record.media[0].url, '/api/content/media/abc123/abc123_1.jpg');
    assert.equal(record.coverMediaId, 'media-1');
    assert.equal(record.media.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('browser fallback handles a broken OpenCLI search filter layout', async () => {
  const calls = [];
  const runner = async (args) => {
    calls.push(args);
    if (args[0] === 'xiaohongshu' && args[1] === 'search') return { ok: false, code: 'cli_error' };
    if (args[0] === 'browser' && args[2] === 'open') return { ok: true, data: {} };
    if (args[0] === 'browser' && args[2] === 'eval') return { ok: true, data: [{ title: '台灯体验', author: 'A', url }] };
    if (args[0] === 'xiaohongshu' && args[1] === 'note') return { ok: true, data: [{ field: 'content', value: '桌面空间够用。' }] };
    return { ok: false, code: 'media_unavailable' };
  };
  const result = await discoverRelatedContent({ category: '台灯', limit: 1 }, { runner });
  assert.equal(result.status, 'ok');
  assert.equal(result.records[0].body, '桌面空间够用。');
  assert.ok(calls.some((args) => args[0] === 'browser' && args[2] === 'close'));
});

test('search covers survive note failures and relevant readable notes rank first', async () => {
  const noteUrl = (id) => `https://www.xiaohongshu.com/search_result/${id}?xsec_token=signed`;
  const cover = 'https://sns-webpic-qc.xhscdn.com/example.jpg';
  const runner = async (args) => {
    if (args[1] === 'search') return { ok: true, data: [
      { url: noteUrl('first'), title: '收纳用品分享', cover },
      { url: noteUrl('second'), title: '书桌台灯使用体验', cover },
      { url: noteUrl('third'), title: '台灯装饰图', cover }
    ] };
    if (args[1] === 'note' && args[2].includes('/second?')) return { ok: true, data: [{ field: 'content', value: '书桌阅读一周，光线比较柔和。' }] };
    return { ok: false, code: 'cli_error' };
  };
  const result = await discoverRelatedContent({ category: '台灯', scene: '书桌', limit: 2 }, { runner, coverFetcher: async () => false });
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].title, '书桌台灯使用体验');
  assert.equal(result.records[0].body, '书桌阅读一周，光线比较柔和。');
  assert.equal(result.records[0].media[0].url, cover);
  assert.equal(result.records[1].title, '台灯装饰图');
  assert.equal(result.status, 'partial');
});

test('signed Xiaohongshu cover is cached locally for stable display', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shopping-cover-'));
  try {
    const record = normalizeXiaohongshu({ url, title: '台灯体验', cover: 'https://sns-webpic-qc.xhscdn.com/signed-cover' }, []);
    const cached = await cacheRemoteCover(record, { root, fetchImpl: async () => new Response(Buffer.from('image-bytes'), { headers: { 'content-type': 'image/webp' } }) });
    assert.equal(cached, true);
    assert.equal(record.media.find((row) => row.id === record.coverMediaId).url, '/api/content/media/abc123/abc123_1.webp');
    assert.equal(fs.readFileSync(path.join(root, 'abc123', 'abc123_1.webp'), 'utf8'), 'image-bytes');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Bilibili shopping content uses the link resolver cover when search has no thumbnail', async () => {
  const videoUrl = 'https://www.bilibili.com/video/BV1cCcqeAEgG';
  const cover = 'https://i0.hdslb.com/bfs/archive/example.jpg';
  const records = await discoverOpenWeb('台灯 使用体验', async () => ({ ok: true, data: [] }), async (url) => {
    assert.equal(url, videoUrl);
    return { ok: true, record: { title: '如何正确使用台灯', body: '台灯使用体验', contentType: 'video', cover, images: [cover], status: 'partial' } };
  }, async () => ({ ok: true, json: async () => ({ code: 0, data: { result: [{ bvid: 'BV1cCcqeAEgG', title: '如何正确使用台灯', author: '作者' }] } }) }));
  assert.equal(records.length, 1);
  assert.equal(records[0].media[0].url, cover);
  assert.equal(records[0].coverMediaId, 'image-1');
});

test('winter skirt search uses questionnaire context and drops unrelated titles', async () => {
  const task = { category: '裙子', goal: '想买秋冬裙子', scene: '通勤', limit: 3,
    questionnaireAnswers: [{ id: 'use', answer: '日常通勤' }, { id: 'priority', answer: '保暖效果' }] };
  assert.equal(buildContentQuery(task), '秋冬通勤裙子');
  const runner = async (args) => args[1] === 'search' ? { ok: true, data: [
    { url: 'https://www.xiaohongshu.com/search_result/a1?xsec_token=x', title: '这里指中长连衣裙' },
    { url: 'https://www.xiaohongshu.com/search_result/a2?xsec_token=x', title: '着装记录' },
    { url: 'https://www.xiaohongshu.com/search_result/a3?xsec_token=x', title: '秋冬通勤半裙保暖穿搭' }
  ] } : { ok: false, code: 'cli_error' };
  const result = await discoverRelatedContent(task, { runner });
  assert.deepEqual(result.records.map((row) => row.title), ['秋冬通勤半裙保暖穿搭']);
});
