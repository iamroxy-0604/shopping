import test from 'node:test';
import assert from 'node:assert/strict';
import { openCliRoute, parseHtmlMetadata, parseInputUrl, resolveLink } from '../src/resolver.mjs';
import { createServer } from '../src/server.mjs';

const publicLookup = async () => [{ address: '93.184.215.14', family: 4 }];
const noCli = async () => ({ ok: false, code: 'opencli_missing' });

test('rejects local, credential-bearing and non-web targets', async () => {
  for (const url of ['http://localhost:3000/', 'http://127.0.0.1/', 'http://192.168.1.2/', 'file:///etc/passwd', 'https://user:pass@example.com/']) {
    assert.equal(parseInputUrl(url), null);
    assert.equal((await resolveLink(url)).code, 'invalid_url');
  }
});

test('does not pass an internal DNS target to OpenCLI', async () => {
  let called = false;
  const result = await resolveLink('https://internal.example/story', {
    lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
    cli: async () => { called = true; return { ok: true, data: {} }; }
  });
  assert.equal(result.code, 'unsafe_target');
  assert.equal(called, false);
});

test('reads a public article without inventing image or video', async () => {
  const html = '<html><head><meta property="og:title" content="桌面阅读灯使用记录"><meta name="description" content="七天体验"><meta property="og:image" content="/cover.jpg"></head><body><article><p>夜间阅读时把灯放在书桌左侧。</p></article></body></html>';
  const result = await resolveLink('https://example.com/post', {
    cli: noCli,
    lookupImpl: publicLookup,
    fetchImpl: async () => new Response(html, { headers: { 'content-type': 'text/html' } })
  });
  assert.equal(result.record.title, '桌面阅读灯使用记录');
  assert.match(result.record.body, /夜间阅读/);
  assert.equal(result.record.cover, 'https://example.com/cover.jpg');
  assert.equal(result.record.contentType, 'article');
  assert.equal(result.record.availability.video, false);
});

test('recognizes playable direct video and video pages without a playable file', async () => {
  const direct = await resolveLink('https://media.example.com/clip.mp4', {
    cli: noCli,
    lookupImpl: publicLookup,
    fetchImpl: async () => new Response(null, { headers: { 'content-type': 'video/mp4' } })
  });
  assert.equal(direct.record.contentType, 'video');
  assert.equal(direct.record.video, 'https://media.example.com/clip.mp4');
  assert.equal(direct.record.status, 'complete');
  const metadata = parseHtmlMetadata('<meta property="og:type" content="video.other"><meta property="og:video" content="https://video.example.com/player/1"><meta property="og:image" content="https://video.example.com/poster.jpg">', 'https://video.example.com/page');
  assert.equal(metadata.videoType, true);
  assert.equal(metadata.video, '');
  assert.equal(metadata.cover, 'https://video.example.com/poster.jpg');
  const page = await resolveLink('https://video.example.com/page', {
    cli: noCli,
    lookupImpl: publicLookup,
    fetchImpl: async () => new Response('<meta property="og:title" content="视频笔记"><meta property="og:type" content="video.other"><meta property="og:image" content="https://video.example.com/poster.jpg">', { headers: { 'content-type': 'text/html' } })
  });
  assert.equal(page.record.contentType, 'video');
  assert.equal(page.record.status, 'partial');
  assert.equal(page.record.issue, 'video_unavailable');
});

test('uses main text when a public page has no article element', () => {
  const page = parseHtmlMetadata('<main><h1>Example Domain</h1><p>This domain is for documentation.</p><img src="/picture.jpg"></main>', 'https://example.com');
  assert.match(page.body, /This domain is for documentation/);
  assert.equal(page.cover, 'https://example.com/picture.jpg');
  const video = parseHtmlMetadata('<video controls><source src="/movie.mp4" type="video/mp4"></video>', 'https://example.com');
  assert.equal(video.video, 'https://example.com/movie.mp4');
  const simple = parseHtmlMetadata('<body><div><h1>Example Domain</h1><p>This domain is for documentation.</p></div></body>', 'https://example.com');
  assert.match(simple.body, /This domain is for documentation/);
});

test('removes generic page chrome and does not classify an article as an image post', async () => {
  const html = '<html><head><title>Material UI installation</title><meta name="description" content="Install Material UI for React"><meta property="og:image" content="/social-card.png"></head><body><nav>Search Docs Pricing</nav><main><form><button>Copy</button></form><h1>Install Material UI</h1><p>Install the default package manager dependencies.</p><button>Copy command</button><p>Components are self-contained and inject only the styles they need.</p></main><footer>GitHub Twitter</footer></body></html>';
  const result = await resolveLink('https://docs.example.com/install', {
    cli: noCli,
    lookupImpl: publicLookup,
    fetchImpl: async () => new Response(html, { headers: { 'content-type': 'text/html' } }),
  });
  assert.equal(result.record.contentType, 'article');
  assert.match(result.record.body, /Components are self-contained/);
  assert.doesNotMatch(result.record.body, /Search Docs|Copy command|GitHub Twitter/);
  assert.equal(result.record.cover, 'https://docs.example.com/social-card.png');
});

test('Bilibili video takes metadata from OpenCLI and uses its official embed', async () => {
  const calls = [];
  const result = await resolveLink('https://www.bilibili.com/video/BV13a8H6dE5L/', {
    cli: async (args) => {
      calls.push(args);
      return { ok: true, data: [
        { field: 'title', value: '视频标题' },
        { field: 'description', value: '作者写的视频简介' },
        { field: 'thumbnail', value: 'http://i2.hdslb.com/cover.jpg' }
      ] };
    },
    lookupImpl: publicLookup,
    fetchImpl: async () => { throw new Error('OpenCLI metadata should be sufficient'); }
  });
  assert.equal(result.record.contentType, 'video');
  assert.equal(result.record.embed, 'https://player.bilibili.com/player.html?bvid=BV13a8H6dE5L');
  assert.equal(result.record.video, '');
  assert.equal(result.record.issue, 'official_embed');
  assert.equal(result.record.body, '作者写的视频简介');
  assert.equal(result.record.cover, 'https://i2.hdslb.com/cover.jpg');
  assert.deepEqual(calls[0], ['bilibili', 'video', 'BV13a8H6dE5L', '-f', 'json']);
  assert.deepEqual(result.record.readBy, ['OpenCLI · B站适配器']);
});

test('routes supported links to their single-content OpenCLI commands', () => {
  assert.equal(openCliRoute(new URL('https://www.xiaohongshu.com/search_result?keyword=台灯')).kind, 'xiaohongshu-search');
  assert.equal(openCliRoute(new URL('https://www.xiaohongshu.com/search_result?keyword=台灯')).args, null);
  assert.deepEqual(openCliRoute(new URL('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).args,
    ['youtube', 'video', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', '-f', 'json']);
  assert.deepEqual(openCliRoute(new URL('https://weibo.com/123456/AbCdEF')).args,
    ['weibo', 'post', 'AbCdEF', '-f', 'json']);
  assert.deepEqual(openCliRoute(new URL('https://weibo.com/2/detail/5336610385430384')).args,
    ['weibo', 'post', '5336610385430384', '-f', 'json']);
  assert.deepEqual(openCliRoute(new URL('https://www.zhihu.com/question/123/answer/456')).args,
    ['zhihu', 'answer-detail', '456', '-f', 'json']);
  assert.equal(openCliRoute(new URL('https://example.com/post')).args, null);
});

test('does not read a Xiaohongshu search page as one note', async () => {
  let called = false;
  const result = await resolveLink('https://www.xiaohongshu.com/search_result?keyword=台灯', {
    cli: async () => { called = true; return { ok: true, data: {} }; }, lookupImpl: publicLookup
  });
  assert.equal(called, false);
  assert.equal(result.record.issue, 'search_results_page');
  assert.equal(result.record.cover, '');
  assert.equal(result.record.status, 'unavailable');
});

test('generic link uses OpenCLI Browser Bridge before public-page fallback', async () => {
  const commands = [];
  const result = await resolveLink('https://example.com/story', {
    cli: async (args) => {
      commands.push(args[2]);
      return args[2] === 'eval'
        ? { ok: true, data: { title: '浏览器标题', body: '浏览器正文', cover: 'https://example.com/photo.jpg' } }
        : { ok: true, data: {} };
    },
    lookupImpl: publicLookup,
    fetchImpl: async () => new Response('<title>网页标题</title>', { headers: { 'content-type': 'text/html' } })
  });
  assert.equal(result.record.title, '浏览器标题');
  assert.equal(result.record.body, '浏览器正文');
  assert.equal(result.record.cover, 'https://example.com/photo.jpg');
  assert.deepEqual(commands, ['open', 'eval', 'close']);
  assert.ok(result.record.readBy.includes('OpenCLI · Browser Bridge'));
});

test('Xiaohongshu note and browser fields become one video record', async () => {
  const url = 'https://www.xiaohongshu.com/explore/abc123?xsec_token=signed';
  const calls = [];
  const cli = async (args) => {
    calls.push(args.slice(0, 3));
    if (args[1] === 'note') return { ok: true, data: [{ field: 'title', value: '通勤穿搭视频' }, { field: 'content', value: '展示了三套通勤搭配。' }] };
    if (args[2] === 'open' || args[2] === 'close') return { ok: true, data: {} };
    if (args[2] === 'eval') return { ok: true, data: { videoType: true, video: 'https://cdn.example.com/a.mp4', cover: 'https://cdn.example.com/a.jpg' } };
    return { ok: false, code: 'unexpected' };
  };
  const result = await resolveLink(url, { cli, lookupImpl: publicLookup });
  assert.equal(result.record.contentType, 'video');
  assert.equal(result.record.body, '展示了三套通勤搭配。');
  assert.equal(result.record.video, 'https://cdn.example.com/a.mp4');
  assert.equal(result.record.cover, 'https://cdn.example.com/a.jpg');
  assert.ok(calls.some((args) => args[2] === 'close'));
});

test('Xiaohongshu note photo wins over site logo and avatar metadata', async () => {
  const brand = 'https://picasso-static.xiaohongshu.com/fe-platform/logo.png';
  const avatar = 'https://sns-avatar-qc.xhscdn.com/avatar/user.webp';
  const notePhoto = 'https://sns-webpic-qc.xhscdn.com/20261018/notes_pre_post/photo-a.webp';
  const secondPhoto = 'https://sns-webpic-qc.xhscdn.com/20261018/note_pre_post_uhdr/photo-b.webp';
  const result = await resolveLink('https://www.xiaohongshu.com/explore/abc123', {
    cli: async (args) => args[2] === 'eval'
      ? { ok: true, data: { title: '台灯体验', body: '笔记正文', cover: brand, images: [brand, avatar, notePhoto, secondPhoto] } }
      : args[1] === 'note' ? { ok: true, data: { title: '台灯体验', content: '笔记正文', cover: brand, images: [brand, avatar, notePhoto, secondPhoto] } }
        : { ok: true, data: {} },
    lookupImpl: publicLookup
  });
  assert.equal(result.record.cover, notePhoto);
  assert.deepEqual(result.record.images.slice(0, 2), [notePhoto, secondPhoto]);
  assert.equal(result.record.images.includes(avatar), false);
  assert.equal(result.record.images.includes(brand), false);
});

test('unreadable Xiaohongshu link stays a truthful unavailable card', async () => {
  const result = await resolveLink('https://www.xiaohongshu.com/explore/abc123?xsec_token=signed', {
    cli: async () => ({ ok: false, code: 'navigation_rejected' }),
    lookupImpl: publicLookup,
    fetchImpl: async () => new Response('', { status: 403 })
  });
  assert.equal(result.ok, true);
  assert.equal(result.record.status, 'unavailable');
  assert.equal(result.record.video, '');
  assert.equal(result.record.body, '');
  assert.equal(result.record.source.url.includes('xsec_token'), true);
});

test('Xiaohongshu missing-note page is not mistaken for a real note', async () => {
  const input = 'https://www.xiaohongshu.com/explore/missing';
  const result = await resolveLink('https://www.xiaohongshu.com/explore/missing', {
    cli: async (args) => args[2] === 'eval'
      ? { ok: true, data: { title: '小红书 - 你访问的页面不见了', body: '页面不存在', cover: 'https://example.com/error.jpg' } }
      : args[1] === 'note' ? { ok: false, code: 'navigation_rejected' } : { ok: true, data: {} },
    lookupImpl: publicLookup,
    fetchImpl: async (url) => url.pathname === '/explore/missing'
      ? new Response(null, { status: 302, headers: { location: '/404' } })
      : new Response('<title>小红书 - 你访问的页面不见了</title><meta property="og:image" content="https://example.com/error.jpg">', { headers: { 'content-type': 'text/html' } })
  });
  assert.equal(result.record.status, 'unavailable');
  assert.equal(result.record.issue, 'content_unavailable');
  assert.equal(result.record.cover, '');
  assert.equal(result.record.body, '');
  assert.equal(result.record.source.url, input);
});

test('standalone HTTP service exposes its own resolver', async () => {
  const server = createServer({ resolve: async (url) => ({ ok: true, record: { title: url } }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /链接转接台/);
    const result = await fetch(`${base}/api/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com' }) });
    assert.equal((await result.json()).record.title, 'https://example.com');
  } finally { server.close(); }
});
