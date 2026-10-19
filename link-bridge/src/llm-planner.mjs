const DETAIL_COMPONENTS = new Set([
  'VideoExperienceDetail',
  'ImageExperienceDetail',
  'ArticleExperienceDetail',
  'MediaUnavailable',
]);

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
  };
}

function promptFor(record) {
  return [
    'You are an A2UI planner for a shopping research interface.',
    'Choose exactly one registered detail component. Do not invent component names.',
    'Available components:',
    '- VideoExperienceDetail: video review, test, tutorial or moving-image content.',
    '- ImageExperienceDetail: image gallery, social post, product experience or visual note.',
    '- ArticleExperienceDetail: long-form article, analysis, Q&A or text-led content.',
    '- MediaUnavailable: only when there is no useful cover, image, video, description or body.',
    'Judge from the actual content semantics and available media, not platform name alone.',
    'Return only compact JSON with this shape:',
    '{"component":"ComponentName","reason":"one concise Chinese sentence","confidence":0.0}',
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

function validatePlan(value) {
  if (!value || !DETAIL_COMPONENTS.has(value.component)) throw new Error('planner_invalid_component');
  const reason = clean(value.reason, 180);
  if (!reason) throw new Error('planner_missing_reason');
  const confidence = Number(value.confidence);
  return {
    component: value.component,
    reason,
    confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : null,
  };
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
        max_tokens: 1000,
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
    return { ...validatePlan(parseJson(content)), model: config.model };
  } finally {
    clearTimeout(timer);
  }
}

