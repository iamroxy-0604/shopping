import { SECTION_VARIANTS, validatePlanAgainstRecord } from './detail-plan.mjs';

function clean(value, limit = 500) {
  return typeof value === 'string' ? value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

function configFrom(env = process.env) {
  return {
    baseUrl: clean(env.LLM_BASE_URL, 500).replace(/\/+$/, ''),
    apiKey: clean(env.LLM_API_KEY, 500),
    model: clean(env.LLM_MODEL, 120) || 'deepseek-v4-flash',
    timeoutMs: Math.min(Math.max(Number(env.LLM_TIMEOUT_MS) || 45000, 3000), 90000),
  };
}

export function plannerConfigured(env = process.env) {
  const config = configFrom(env);
  return Boolean(config.baseUrl && config.apiKey && config.model);
}

function recordForPrompt(record) {
  return {
    platform: clean(record?.source?.platform, 40),
    sourceUrl: clean(record?.source?.url, 500),
    contentType: clean(record?.contentType, 40),
    title: clean(record?.title, 180),
    author: clean(record?.author, 80),
    description: clean(record?.description, 500),
    body: clean(record?.body, 900),
    hasCover: Boolean(record?.cover),
    imageCount: Array.isArray(record?.images) ? Math.min(record.images.length, 8) : 0,
    hasPlayableVideo: Boolean(record?.video),
    duration: clean(record?.duration, 20),
    coverUrl: clean(record?.cover, 500),
    analysis: record?.analysis || {},
    products: Array.isArray(record?.products) ? record.products.slice(0, 5) : [],
    evidence: Array.isArray(record?.evidence) ? record.evidence.slice(0, 12) : [],
  };
}

function promptFor(record) {
  return [
    'You are an A2UI planner for a shopping research interface.',
    'Choose 2 to 8 registered detail sections in reading order. SourceActions is required exactly once.',
    `Allowed component variants: ${JSON.stringify(SECTION_VARIANTS)}`,
    'Only use sections with corresponding record data. Never invent prices, metrics, evidence, links, media, HTML, CSS or JavaScript.',
    'For a generic web page, remove navigation labels and unrelated examples from the display summary.',
    'Return only compact JSON with this shape:',
    '{"planVersion":"1","reason":"Chinese sentence","confidence":0.9,"theme":{"name":"warm","density":"comfortable"},"content":{"displayTitle":"title","displaySummary":"grounded summary","showCover":true},"sections":[{"id":"source","component":"SourceHeader","variant":"default"},{"id":"actions","component":"SourceActions","variant":"default"}]}',
    `Content record: ${JSON.stringify(recordForPrompt(record))}`,
  ].join('\n');
}

function parseJson(text) {
  const source = clean(text, 4000).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('planner_invalid_json');
  return JSON.parse(source.slice(start, end + 1));
}

export async function planDetailComponent(record, { fetchImpl = fetch, env = process.env } = {}) {
  const config = configFrom(env);
  if (!plannerConfigured(env)) throw new Error('planner_not_configured');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.1,
        // The configured model may emit hidden reasoning tokens before its JSON answer.
        max_tokens: 1600,
        messages: [
          { role: 'system', content: 'Return valid JSON only. You may only select a component from the supplied catalog.' },
          { role: 'user', content: promptFor(record) },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`planner_http_${response.status}`);
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('planner_empty_response');
    return { ...validatePlanAgainstRecord(parseJson(content), record), model: config.model };
  } finally {
    clearTimeout(timer);
  }
}

