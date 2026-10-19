import React, { useEffect, useState } from 'react';
import { shoppingComponents } from './shopping.jsx';
import { z } from 'zod';
import { Catalog, CommonSchemas } from '@a2ui/web_core/v0_9';
import { createComponentImplementation } from '@a2ui/react/v0_9';
import { alpha, Box, Button, Card, Chip, IconButton, Stack, Typography } from '@mui/material';
import useEmblaCarousel from 'embla-carousel-react';
import {
  ArrowSquareOut,
  CaretLeft,
  CaretRight,
  Heart,
  Images,
  Play,
  WarningCircle,
} from '@phosphor-icons/react';

export const SHIGUANG_CATALOG_ID = 'https://shiguang.local/a2ui/catalogs/content-v1.json';

const optionalText = CommonSchemas.DynamicString.optional();
const mediaList = z.array(z.string().url()).max(8).optional();

const previewApi = {
  name: 'ExperiencePreview',
  schema: z.object({
    platform: CommonSchemas.DynamicString,
    author: CommonSchemas.DynamicString,
    title: CommonSchemas.DynamicString,
    excerpt: optionalText,
    cover: optionalText,
    duration: optionalText,
    engagement: optionalText,
    format: CommonSchemas.DynamicString,
    onOpen: CommonSchemas.Action,
  }),
};

const detailShape = {
  platform: CommonSchemas.DynamicString,
  author: CommonSchemas.DynamicString,
  title: CommonSchemas.DynamicString,
  body: optionalText,
  cover: optionalText,
  duration: optionalText,
  engagement: optionalText,
  sourceUrl: CommonSchemas.DynamicString,
  images: mediaList,
  onOpenSource: CommonSchemas.Action,
};

const videoDetailApi = { name: 'VideoExperienceDetail', schema: z.object({ ...detailShape, video: optionalText }) };
const imageDetailApi = { name: 'ImageExperienceDetail', schema: z.object(detailShape) };
const articleDetailApi = { name: 'ArticleExperienceDetail', schema: z.object(detailShape) };
const unavailableApi = {
  name: 'MediaUnavailable',
  schema: z.object({
    platform: CommonSchemas.DynamicString,
    title: CommonSchemas.DynamicString,
    message: CommonSchemas.DynamicString,
    sourceUrl: CommonSchemas.DynamicString,
    onOpenSource: CommonSchemas.Action,
  }),
};

function PlatformChip({ platform }) {
  const key = String(platform || '').toLowerCase();
  const color = key.includes('知乎') ? '#2878d0' : key.includes('b') ? '#ee659d' : '#ff5267';
  return <Chip label={platform} size="small" sx={{ height: 25, bgcolor: color, color: '#fff', fontWeight: 750, '& .MuiChip-label': { px: 1.2 } }} />;
}

function Cover({ src, title, video, duration }) {
  return (
    <Box className="experience-cover" sx={{ position: 'relative', overflow: 'hidden', bgcolor: 'background.default', aspectRatio: '4 / 3' }}>
      {src ? <Box component="img" src={src} alt="" sx={{ width: '100%', height: '100%', display: 'block', objectFit: 'cover' }} /> : (
        <Stack alignItems="center" justifyContent="center" sx={{ height: '100%', color: 'text.secondary' }}>
          <Images size={30} weight="duotone" /><Typography variant="caption" sx={{ mt: 1 }}>封面暂未取得</Typography>
        </Stack>
      )}
      {video && <Box className="play-badge"><Play size={18} weight="fill" /></Box>}
      {duration && <Box className="duration-badge">{duration}</Box>}
    </Box>
  );
}

export const ExperiencePreview = createComponentImplementation(previewApi, ({ props }) => {
  const article = props.format === 'article';
  return (
    <Card className={`experience-preview ${article ? 'is-article' : ''}`} elevation={0}>
      <Box component="button" type="button" onClick={props.onOpen} className="preview-button">
        {!article && <Cover src={props.cover} title={props.title} video={props.format === 'video'} duration={props.duration} />}
        <Stack className="preview-copy" spacing={1}>
          {article && <Typography className="article-kicker" variant="caption">{props.platform} · 深度图文</Typography>}
          <Typography className="preview-title">{props.title}</Typography>
          {article && props.excerpt && <Typography className="preview-excerpt">{props.excerpt}</Typography>}
          <Stack direction="row" alignItems="center" spacing={0.7} className="preview-meta">
            <PlatformChip platform={props.platform} />
            <Typography variant="caption" noWrap>{props.author}</Typography>
          </Stack>
          {props.engagement && <Typography className="engagement" variant="caption"><Heart size={16} /> {props.engagement}</Typography>}
        </Stack>
      </Box>
    </Card>
  );
});

function DetailHeader({ platform, author, engagement }) {
  return (
    <Stack direction="row" alignItems="center" spacing={1.1} sx={{ mb: 2 }}>
      <PlatformChip platform={platform} />
      <Typography variant="body2" sx={{ fontWeight: 650 }}>{author}</Typography>
      <Box sx={{ flex: 1 }} />
      {engagement && <Typography variant="caption" color="text.secondary"><Heart size={15} /> {engagement}</Typography>}
    </Stack>
  );
}

function SourceButton({ onClick }) {
  return <Button fullWidth variant="contained" size="large" onClick={onClick} endIcon={<ArrowSquareOut size={18} />}>查看原内容</Button>;
}

export const VideoExperienceDetail = createComponentImplementation(videoDetailApi, ({ props }) => (
  <Stack className="experience-detail" spacing={2}>
    <DetailHeader {...props} />
    {props.video ? (
      <Box component="video" src={props.video} poster={props.cover} controls playsInline sx={{ width: '100%', borderRadius: 4, bgcolor: '#151515', maxHeight: 420 }} />
    ) : <Cover src={props.cover} title={props.title} video duration={props.duration} />}
    <Typography variant="h4">{props.title}</Typography>
    {props.body && <Typography color="text.secondary" sx={{ lineHeight: 1.75 }}>{props.body}</Typography>}
    {!props.video && <Box className="media-note"><WarningCircle size={20} />已识别为视频内容，当前链接只提供封面与摘要，播放请前往原站。</Box>}
    <SourceButton onClick={props.onOpenSource} />
  </Stack>
));

function ImageCarousel({ images = [], cover, title }) {
  const slides = [...new Set([cover, ...images].filter(Boolean))];
  const [emblaRef, embla] = useEmblaCarousel({ loop: slides.length > 1 });
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    if (!embla) return undefined;
    const sync = () => setSelected(embla.selectedScrollSnap());
    sync();
    embla.on('select', sync);
    embla.on('reInit', sync);
    return () => { embla.off('select', sync); embla.off('reInit', sync); };
  }, [embla]);
  return (
    <Box className="image-carousel">
      <Box className="embla-viewport" ref={emblaRef}><Box className="embla-container">
        {slides.map((src, index) => <Box className="embla-slide" key={src}><Box component="img" src={src} alt={`${title} ${index + 1}`} /></Box>)}
      </Box></Box>
      {slides.length > 1 && <>
        <IconButton className="carousel-arrow prev" onClick={() => embla?.scrollPrev()} aria-label="上一张"><CaretLeft /></IconButton>
        <IconButton className="carousel-arrow next" onClick={() => embla?.scrollNext()} aria-label="下一张"><CaretRight /></IconButton>
        <Box className="image-count">{selected + 1} / {slides.length}</Box>
      </>}
    </Box>
  );
}

export const ImageExperienceDetail = createComponentImplementation(imageDetailApi, ({ props }) => (
  <Stack className="experience-detail" spacing={2}>
    <DetailHeader {...props} />
    <Typography variant="h4">{props.title}</Typography>
    {props.body && <Typography color="text.secondary" sx={{ lineHeight: 1.75 }}>{props.body}</Typography>}
    <ImageCarousel images={props.images} cover={props.cover} title={props.title} />
    <SourceButton onClick={props.onOpenSource} />
  </Stack>
));

export const ArticleExperienceDetail = createComponentImplementation(articleDetailApi, ({ props }) => (
  <Stack className="experience-detail article-detail" spacing={2}>
    <DetailHeader {...props} />
    <Typography variant="h3">{props.title}</Typography>
    {props.body && <Typography className="article-body">{props.body}</Typography>}
    {props.cover && <Box component="img" src={props.cover} alt="" className="article-image" />}
    <SourceButton onClick={props.onOpenSource} />
  </Stack>
));

export const MediaUnavailable = createComponentImplementation(unavailableApi, ({ props }) => (
  <Stack className="unavailable-state" alignItems="center" spacing={2}>
    <Box className="unavailable-icon"><WarningCircle size={36} weight="duotone" /></Box>
    <PlatformChip platform={props.platform} />
    <Typography variant="h5" align="center">{props.title}</Typography>
    <Typography color="text.secondary" align="center">{props.message}</Typography>
    <SourceButton onClick={props.onOpenSource} />
  </Stack>
));

export const shiguangCatalog = new Catalog(
  SHIGUANG_CATALOG_ID,
  'v0.9',
  [ExperiencePreview, VideoExperienceDetail, ImageExperienceDetail, ArticleExperienceDetail, MediaUnavailable, ...shoppingComponents],
);

