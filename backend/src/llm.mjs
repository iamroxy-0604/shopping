const DEFAULT_TIMEOUT_MS = 15000;

function cleanBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function extractContent(payload) {
  const content = payload?.choices?.[0]?.message?.content ?? payload?.output?.[0]?.content?.[0]?.text;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') return content.text || JSON.stringify(content);
  return '';
}

function parseJsonContent(content) {
  const text = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(text); } catch { return null; }
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function completeJson({ system, user, env, fetchImpl, timeoutMs }) {
  if (!hasLlmConfig(env)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${cleanBaseUrl(env.LLM_BASE_URL)}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.LLM_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: env.LLM_MODEL, temperature: 0.1, max_tokens: 700, chat_template_kwargs: { enable_thinking: false }, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(user) }] }),
      signal: controller.signal
    });
    if (!response.ok) return null;
    return parseJsonContent(extractContent(await response.json()));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function hasLlmConfig(env = process.env) {
  return Boolean(env.LLM_BASE_URL && env.LLM_API_KEY && env.LLM_MODEL);
}

export async function understandShoppingMessage({ message, memory = {}, env = process.env, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!hasLlmConfig(env)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const system = `你是购物搜索助手的需求理解和记忆模块。只输出 JSON，不要解释，不要 Markdown。字段必须是：
{"query":"给商品接口的简洁关键词","category":"标准商品类目或空字符串","style":"用户明确表达的风格或空字符串","scene":"使用场景或空字符串","maxPrice":null,"minPrice":null,"needsClarification":false,"question":"需要追问时的问题，否则空字符串","memoryTags":[],"memorySummary":"一句自然的偏好描述"}
规则：把“胭脂”统一为“腮红”等常见同义词；query 只保留商品、风格、场景关键词；不要把“有推荐吗、帮我看看、我想买”等套话放进类目或记忆；memoryTags 只能是用户明确表达、未来仍然有用的偏好，最多4个；价格必须是数字或 null；不要编造品牌和价格。`;
  const parsed = await completeJson({ system, user: { message, memory }, env, fetchImpl, timeoutMs });
  if (parsed) {
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      query: String(parsed.query || '').trim(),
      category: String(parsed.category || '').trim(),
      style: String(parsed.style || '').trim(),
      scene: String(parsed.scene || '').trim(),
      maxPrice: toNullableNumber(parsed.maxPrice),
      minPrice: toNullableNumber(parsed.minPrice),
      needsClarification: Boolean(parsed.needsClarification),
      question: String(parsed.question || '').trim(),
      memoryTags: Array.isArray(parsed.memoryTags) ? parsed.memoryTags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 4) : [],
      memorySummary: String(parsed.memorySummary || '').trim()
    };
  }
  return null;
}

export async function generateRecommendationReasons({ message, preferences = {}, items = [], env = process.env, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const system = `你是购物推荐分析模块。根据用户需求和真实商品字段，为每个商品输出统一格式、但内容有差异的推荐信息。只输出 JSON 数组，格式为：[{"id":"商品ID","recommendation":"核心特点 + 风格或场景 + 购买建议，约20-35字","suitableFor":"适合什么人、肤色、妆效或使用场景；没有依据时写需要查看具体色号","highlight":"最值得关注的一个亮点；没有依据时写空字符串","watchout":"一个真实、克制的注意事项；没有依据时写空字符串"}]。只能使用输入中已有的信息和标题中明确出现的色调、妆效、场景词，不要编造成分、功效、销量、材质或品牌信息；不要把所有商品写成同一句；不要使用“符合XX风格，属于XX类目”这种机械句式；每个字段不超过40个汉字。`;
  const parsed = await completeJson({ system, user: { message, preferences, items: items.map(({ id, title, price, coupon, sales, shopName, matchReasons }) => ({ id, title, price, coupon, sales, shopName, matchReasons })) }, env, fetchImpl, timeoutMs });
  if (!Array.isArray(parsed)) return null;
  return parsed.reduce((out, entry) => {
    if (entry?.id && entry?.recommendation) {
      out[String(entry.id)] = {
        recommendation: String(entry.recommendation).trim(),
        suitableFor: String(entry.suitableFor || '').trim(),
        highlight: String(entry.highlight || '').trim(),
        watchout: String(entry.watchout || '').trim()
      };
    }
    return out;
  }, {});
}

export async function generateShoppingIntro({ message, preferences = {}, items = [], env = process.env, fetchImpl = fetch, timeoutMs = 12000 }) {
  const system = `你是一个自然、体贴的中文购物导购。根据用户原话、已记住的偏好和商品概况，写一段不超过80字的回复。语气像懂用户的客服，不要说“按关键词”“搜索词”“接口”“筛选条件”，不要复述一串关键词；要自然表达你理解了用户想要什么、这次挑了几款，以及可以继续从哪些维度帮用户缩小范围。只输出纯文本，不要 Markdown。`;
  if (!hasLlmConfig(env)) return '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${cleanBaseUrl(env.LLM_BASE_URL)}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.LLM_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: env.LLM_MODEL, temperature: 0.5, max_tokens: 180, chat_template_kwargs: { enable_thinking: false }, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({ message, preferences, productCount: items.length, products: items.map((item) => ({ title: item.title, price: item.price, matchReasons: item.matchReasons })) }) }] }),
      signal: controller.signal
    });
    if (!response.ok) return '';
    const content = extractContent(await response.json()).trim();
    return content.replace(/^```[\s\S]*?\n|```$/g, '').trim();
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}
