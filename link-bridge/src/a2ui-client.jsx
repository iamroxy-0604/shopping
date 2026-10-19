import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageProcessor } from '@a2ui/web_core/v0_9';
import { A2uiSurface } from '@a2ui/react/v0_9';
import { ThemeProvider } from '@mui/material/styles';
import { Box, Button, Chip, CircularProgress, FormControl, MenuItem, Select, Stack, TextField, Typography } from '@mui/material';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowRight, Brain, CheckCircle, Flask, LinkSimple, MagicWand, X } from '@phosphor-icons/react';
import { shiguangCatalog } from './react-catalog/catalog.jsx';
import { createShiguangTheme, themeLabels, themeNames, themeStyle } from './theme/registry.js';

const DEMOS = [
  {
    id: 'demo-xhs', source: { platform: '小红书', url: 'https://www.xiaohongshu.com/explore/demo-powerbank' }, contentType: 'image',
    author: '阿杰的数码生活', title: '实测充电速度和续航，日常使用很够用',
    description: '自带线设计很方便，给手机充到80%大约需要30分钟。体积小，通勤包里基本不占空间。',
    cover: 'https://images.unsplash.com/photo-1609091839311-d5365f9ff1c5?auto=format&fit=crop&w=900&q=88',
    images: [
      'https://images.unsplash.com/photo-1609091839311-d5365f9ff1c5?auto=format&fit=crop&w=900&q=88',
      'https://images.unsplash.com/photo-1585338107529-13afc5f02586?auto=format&fit=crop&w=900&q=88',
      'https://images.unsplash.com/photo-1583394838336-acd977736f90?auto=format&fit=crop&w=900&q=88',
    ], engagement: 36000, status: 'complete',
  },
  {
    id: 'demo-zhihu', source: { platform: '知乎', url: 'https://www.zhihu.com/question/demo' }, contentType: 'article',
    author: '硬件观察室', title: '充电宝到底怎么选？从容量、协议到安全性的完整判断',
    description: '选择充电宝时，容量只是第一层指标。更重要的是充电协议、额定容量、电芯和保护机制。',
    body: '如果主要用于日常通勤，10000mAh 通常能在重量与续航之间取得较好平衡。需要关注商品标注的额定容量，并核对自己手机支持的快充协议。',
    cover: 'https://images.unsplash.com/photo-1615526675159-e248c3021d3f?auto=format&fit=crop&w=1000&q=88', engagement: 18400, status: 'complete',
  },
  {
    id: 'demo-bili', source: { platform: 'B站', url: 'https://www.bilibili.com/video/BV1eFC9YRECm' }, contentType: 'video',
    author: '小白测评', title: '16款充电宝实测：怎么买不踩坑？',
    description: '从实际输出、快充协议、发热和重量四个维度进行横向测试。',
    cover: 'https://i1.hdslb.com/bfs/archive/40f6e90ff7d221a69a920a12729e776e8153a149.jpg', duration: '12:48', engagement: 1993402, status: 'partial',
  },
];

async function api(path, payload) {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const result = await response.json();
  if (!result.ok) throw new Error(result.message || result.code || '请求失败');
  return result;
}

function Surface({ presentation, onAction }) {
  const model = useMemo(() => {
    if (!presentation) return null;
    const processor = new MessageProcessor([shiguangCatalog], onAction);
    processor.processMessages(presentation.messages);
    return { processor, surface: processor.getSurface(presentation.surfaceId) };
  }, [presentation, onAction]);
  useEffect(() => () => model?.processor?.dispose(), [model]);
  return model?.surface ? <A2uiSurface surface={model.surface} /> : null;
}

function App() {
  const [themeName, setThemeName] = useState('warm');
  const [records, setRecords] = useState(DEMOS);
  const [previews, setPreviews] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('正在启动 React A2UI Renderer…');

  const loadPreviews = useCallback(async (nextRecords) => {
    const next = await Promise.all(nextRecords.map((record) => api('/api/react-compose', { record, mode: 'preview' })));
    setPreviews(next);
    setStatus(`已用拾光 Catalog 渲染 ${next.length} 个 A2UI Surface`);
  }, []);

  useEffect(() => { loadPreviews(records).catch((error) => setStatus(error.message)); }, [records, loadPreviews]);

  const openDetail = useCallback(async (record) => {
    setSelected(record); setDetail(null); setDialogOpen(true);
    try { setDetail(await api('/api/react-compose', { record, mode: 'detail', usePlanner: true })); }
    catch (error) { setStatus(`详情生成失败：${error.message}`); }
  }, []);

  const actionFor = useCallback((record) => (action) => {
    if (action.name === 'open_detail') openDetail(record);
    if (action.name === 'open_source') window.open(action.context?.sourceUrl || record.source.url, '_blank', 'noopener,noreferrer');
  }, [openDetail]);

  const submit = async (event) => {
    event.preventDefault(); if (!url.trim()) return;
    setBusy(true); setStatus('正在通过链接转接器读取真实内容…');
    try {
      const result = await api('/api/resolve', { url: url.trim() });
      setRecords([result.record, ...records.filter((item) => item.id !== result.record.id)].slice(0, 4));
      setStatus('真实链接已读取，正在生成 A2UI 组件。');
    } catch (error) { setStatus(`读取失败：${error.message}`); }
    finally { setBusy(false); }
  };

  return (
    <ThemeProvider theme={createShiguangTheme(themeName)}>
      <Box className={`lab theme-${themeName}`} style={themeStyle(themeName)}>
        <header className="topbar">
          <a href="/" className="brand"><span><MagicWand size={19} weight="duotone" /></span>拾光 · A2UI LAB</a>
          <Stack direction="row" alignItems="center" spacing={1.5}>
            <span className="renderer-badge"><CheckCircle size={16} weight="fill" /> React Renderer</span>
            <FormControl size="small"><Select value={themeName} onChange={(e) => setThemeName(e.target.value)} aria-label="视觉主题">
              {themeNames.map((name) => <MenuItem value={name} key={name}>{themeLabels[name]}</MenuItem>)}
            </Select></FormControl>
          </Stack>
        </header>

        <main>
          <section className="intro">
            <Chip icon={<Flask size={15} />} label="独立模块 · 未接入购物智能体" />
            <Typography component="h1">真实内容，<br /><em>由 A2UI 选择正确的表达。</em></Typography>
            <Typography className="intro-copy">LLM Planner 理解真实内容并从拾光 Catalog 选择组件，React Renderer 再执行受约束的 A2UI 消息。</Typography>
          </section>

          <section className="resolver-panel">
            <form onSubmit={submit}>
              <TextField fullWidth value={url} onChange={(e) => setUrl(e.target.value)} placeholder="粘贴小红书、B站、知乎或公开网页链接" InputProps={{ startAdornment: <LinkSimple size={20} /> }} />
              <Button type="submit" variant="contained" disabled={busy} endIcon={busy ? <CircularProgress size={16} color="inherit" /> : <ArrowRight />}>读取并编排</Button>
            </form>
            <p className="status" role="status">{status}</p>
          </section>

          <section className="showcase">
            <div className="section-heading"><div><span>01 / A2UI SURFACES</span><h2>多来源预览组件</h2><p>点击卡片，A2UI 会按内容与购物证据编排详情区块。</p></div><b>{previews.length} surfaces</b></div>
            <div className="preview-grid">
              {previews.map((presentation, index) => <Surface key={presentation.surfaceId} presentation={presentation} onAction={actionFor(records[index])} />)}
            </div>
          </section>

          <section className="architecture-strip">
            <span>链接转接器</span><ArrowRight /><span>LLM Planner</span><ArrowRight /><span>A2UI 消息</span><ArrowRight /><span>拾光 Catalog</span><ArrowRight /><strong>React 组件</strong>
          </section>
        </main>

        <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
          <Dialog.Portal>
            <Dialog.Overlay className="dialog-overlay" />
            <Dialog.Content className={`dialog-content theme-${themeName}`} style={themeStyle(themeName)} aria-describedby={undefined}>
              <div className="dialog-handle" />
              <Dialog.Title className="sr-only">{selected?.title || '内容详情'}</Dialog.Title>
              <Dialog.Close asChild><button className="dialog-close" aria-label="关闭"><X size={24} /></button></Dialog.Close>
              <div className="dialog-scroll">
                {detail && selected ? <>
                  <div className={`planner-trace ${detail.planner?.used ? 'is-llm' : 'is-fallback'}`}>
                    <Brain size={18} weight="duotone" />
                    <div><strong>{detail.planner?.used ? 'LLM Planner 已参与' : '规则编排'}</strong><span>{detail.planner?.reason}</span></div>
                    <code>{detail.sectionCount ? `${detail.sectionCount} 个区块` : detail.component}</code>
                  </div>
                  <Surface presentation={detail} onAction={actionFor(selected)} />
                </> : <div className="detail-loading"><CircularProgress /><span>LLM Planner 正在编排详情区块…</span></div>}
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </Box>
    </ThemeProvider>
  );
}

createRoot(document.getElementById('root')).render(<App />);

