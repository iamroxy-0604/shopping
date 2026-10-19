import React from 'react';
import { z } from 'zod';
import { CommonSchemas } from '@a2ui/web_core/v0_9';
import { createComponentImplementation } from '@a2ui/react/v0_9';
import { Box, Button, Chip, Stack, Typography } from '@mui/material';

const text = CommonSchemas.DynamicString;
const optional = text.optional();
const url = z.string().url().refine((value) => /^https?:/.test(value));
const evidenceRef = z.string().max(80).optional();
const takeaway = z.object({ text: z.string().min(1).max(180), sentiment: z.enum(['positive', 'negative', 'neutral']), evidenceId: evidenceRef });
const metric = z.object({ label: z.string().min(1).max(60), value: z.string().min(1).max(60), evidenceId: z.string().min(1).max(80) });
const product = z.object({ name: z.string().min(1).max(100), model: z.string().max(80).optional(), image: url.or(z.literal('')).optional(), price: z.string().max(40).optional(), matchStatus: z.string().max(40).optional(), url: url.or(z.literal('')).optional() });
const evidence = z.object({ id: z.string().min(1).max(80), text: z.string().min(1).max(300), locator: z.string().max(80).optional(), sourceType: z.string().max(40).optional() });
const advice = z.object({ verdict: z.string().min(1).max(180), reasons: z.array(z.string().max(120)).max(4), notFor: z.array(z.string().max(120)).max(3) });
const api = (name, schema, render, allowedChildren) => createComponentImplementation({ name, schema: z.object(schema), ...(allowedChildren ? { allowedChildren } : {}) }, render);
const heading = (label) => <Typography className="shopping-heading" component="h3">{label}</Typography>;
const empty = <Typography className="shopping-empty">暂无可核实的信息</Typography>;
const section = (name, content) => <section className={`shopping-section shopping-${name}`}>{content}</section>;

const CHILDREN = ['SourceHeader', 'HeroMedia', 'ContentSummary', 'KeyTakeaways', 'ProsCons', 'TestMetrics', 'ProductMention', 'ProductComparison', 'BuyingAdvice', 'EvidenceList', 'DecisionChecklist', 'SourceActions'];
export const DetailStack = api('DetailStack', { children: CommonSchemas.ChildList, density: z.enum(['comfortable', 'compact']).optional() }, ({ props, buildChild }) => (
  <div className={`detail-stack density-${props.density || 'comfortable'}`}>{(Array.isArray(props.children) ? props.children : []).slice(0, 8).map((child, index) => <React.Fragment key={index}>{buildChild(typeof child === 'string' ? child : child?.id || child?.componentId)}</React.Fragment>)}</div>
), CHILDREN);

export const SourceHeader = api('SourceHeader', { variant: z.literal('default'), platform: text, author: optional, title: optional, engagement: optional }, ({ props }) => section('source', <>
  <Stack direction="row" alignItems="center" spacing={1}><Chip size="small" label={props.platform} /><Typography variant="body2">{props.author || '网页内容'}</Typography><Box sx={{ flex: 1 }} /><Typography variant="caption">{props.engagement}</Typography></Stack>
</>));

export const HeroMedia = api('HeroMedia', { variant: z.enum(['video', 'gallery', 'image', 'poster']), title: text, cover: optional, video: optional, images: z.array(url).max(8).optional(), duration: optional }, ({ props }) => section('hero', <>
  {props.video && props.variant === 'video' ? <video src={props.video} poster={props.cover} controls playsInline /> : props.variant === 'gallery' && props.images?.length ? <div className="shopping-gallery">{props.images.map((src, i) => <img src={src} alt={`${props.title} ${i + 1}`} key={src} />)}</div> : props.cover ? <img src={props.cover} alt="" /> : empty}
  {props.variant === 'poster' && <p className="shopping-muted">当前仅提供视频封面，播放请前往原站。</p>}
  {props.duration && <span className="shopping-duration">{props.duration}</span>}
</>));

export const ContentSummary = api('ContentSummary', { variant: z.literal('default'), title: text, body: optional }, ({ props }) => section('summary', <><Typography component="h2" className="shopping-title">{props.title}</Typography>{props.body ? <p>{props.body}</p> : empty}</>));
export const KeyTakeaways = api('KeyTakeaways', { variant: z.literal('default'), items: z.array(takeaway).max(4) }, ({ props }) => section('takeaways', <>{heading('核心结论')}{props.items.length ? <ul>{props.items.map((item, i) => <li key={i} className={`sentiment-${item.sentiment}`}>{item.text}{item.evidenceId && <small> · {item.evidenceId}</small>}</li>)}</ul> : empty}</>));
export const ProsCons = api('ProsCons', { variant: z.enum(['balanced', 'compact', 'evidence-first']), pros: z.array(z.string().max(150)).max(4), cons: z.array(z.string().max(150)).max(4) }, ({ props }) => section('pros-cons', <>{heading('优点与不足')}<div className="shopping-columns">{props.pros.length > 0 && <div><b>优点</b><ul>{props.pros.map((value, i) => <li key={i}>{value}</li>)}</ul></div>}{props.cons.length > 0 && <div><b>不足</b><ul>{props.cons.map((value, i) => <li key={i}>{value}</li>)}</ul></div>}{!props.pros.length && !props.cons.length && empty}</div></>));
export const TestMetrics = api('TestMetrics', { variant: z.literal('grid'), items: z.array(metric).max(6) }, ({ props }) => section('metrics', <>{heading('实测指标')}<div className="shopping-metrics">{props.items.length ? props.items.map((item, i) => <div key={i}><small>{item.label}</small><strong>{item.value}</strong><small>证据：{item.evidenceId}</small></div>) : empty}</div></>));
export const ProductMention = api('ProductMention', { variant: z.literal('default'), value: product }, ({ props }) => section('product', <>{heading('提及商品')}<div className="shopping-product">{props.value.image && <img src={props.value.image} alt="" />}<div><b>{props.value.name}</b><p>{props.value.model}</p><small>{props.value.matchStatus}</small>{props.value.price && <p>{props.value.price}</p>}</div></div></>));
export const ProductComparison = api('ProductComparison', { variant: z.enum(['table', 'cards', 'compact']), items: z.array(product).min(2).max(5) }, ({ props }) => section('comparison', <>{heading('商品对比')}<div className="shopping-products">{props.items.map((item, i) => <div className="shopping-product" key={i}>{item.image && <img src={item.image} alt="" />}<div><b>{item.name}</b><p>{item.model}</p><small>{item.matchStatus}</small>{item.price && <p>{item.price}</p>}</div></div>)}</div></>));
export const BuyingAdvice = api('BuyingAdvice', { variant: z.literal('default'), value: advice }, ({ props }) => section('advice', <>{heading('购买建议')}<strong>{props.value.verdict}</strong>{props.value.reasons.length > 0 && <ul>{props.value.reasons.map((item, i) => <li key={i}>{item}</li>)}</ul>}{props.value.notFor.length > 0 && <p className="shopping-muted">不适合：{props.value.notFor.join('、')}</p>}</>));
export const EvidenceList = api('EvidenceList', { variant: z.literal('default'), items: z.array(evidence).max(12) }, ({ props }) => section('evidence', <>{heading('原文证据')}<ol>{props.items.map((item) => <li key={item.id}><span>{item.text}</span>{item.locator && <small> · {item.locator}</small>}</li>)}</ol></>));
export const DecisionChecklist = api('DecisionChecklist', { variant: z.literal('default'), items: z.array(z.string().max(120)).max(5) }, ({ props }) => section('checklist', <>{heading('选购前核对')}<ul>{props.items.map((item, i) => <li key={i}>{item}</li>)}</ul></>));
export const SourceActions = api('SourceActions', { variant: z.literal('default'), sourceUrl: text, onOpenSource: CommonSchemas.Action }, ({ props }) => section('actions', <Button fullWidth variant="contained" onClick={props.onOpenSource}>查看原内容</Button>));

export const shoppingComponents = [DetailStack, SourceHeader, HeroMedia, ContentSummary, KeyTakeaways, ProsCons, TestMetrics, ProductMention, ProductComparison, BuyingAdvice, EvidenceList, DecisionChecklist, SourceActions];
