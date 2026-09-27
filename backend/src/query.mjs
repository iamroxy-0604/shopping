const PRICE_PATTERNS = [
  /(?:预算|价格|价位)[^\d]{0,8}(\d+(?:\.\d+)?)\s*(?:元)?[^\d]{0,8}(?:以内|以下|封顶)/i,
  /(?:低于|不超过|少于)\s*(\d+(?:\.\d+)?)\s*(?:元)?/i,
  /(?:\d+(?:\.\d+)?)\s*(?:元)?(?:以内|以下)/i
];

const STYLE_WORDS = ['韩系', '日系', '北欧', '法式', '奶油风', '原木', '极简', '简约', '复古', 'ins风', '小红书风', '低饱和', '暖色', '冷色', '自然妆效', '哑光', '水光'];
const SCENE_WORDS = ['出租屋', '宿舍', '桌面', '卧室', '客厅', '办公室', '通勤', '旅行', '户外'];
const FILLER_PATTERN = /^(一个|一款|一件|一套|几个|一些|个|件|套|想要|想买|帮我找|帮我推荐)\s*/;

function firstMatch(text, words) { return words.find((word) => text.includes(word)) || null; }
function cleanCategory(value = '') {
  return value.replace(FILLER_PATTERN, '')
    .replace(/^(韩系|日系|北欧|法式|奶油风|原木|极简|简约|复古|ins风|小红书风|低饱和)\s*(的|风格的)?\s*/i, '')
    .replace(/(预算|价格|价位|低于|不超过|少于)\s*\d+(?:\.\d+)?\s*元?(?:以内|以下|封顶)?/g, '')
    .replace(/(适合|用于|用在|放在).+$/g, '').trim()
    .replace(/^胭脂$/, '腮红')
    .replace(/^唇彩$/, '唇釉');
}

export function parseShoppingQuery(input = '') {
  const text = input.trim();
  const result = { query: text, filters: {}, extracted: { keywords: text, priceRange: null, category: null, style: null, scene: null } };
  for (const pattern of PRICE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      result.filters.end_price = Number(match[1]);
      result.extracted.priceRange = { max: Number(match[1]) };
      break;
    }
  }
  result.extracted.style = firstMatch(text, STYLE_WORDS);
  result.extracted.scene = SCENE_WORDS.filter((word) => text.includes(word)).slice(0, 2).join(' ') || null;
  const category = text.match(/(?:想买|找|推荐|需要|看看)\s*([^，。,.！!？?]{2,30}?)(?:，|。|,|！|!|？|\?|$)/);
  const cleanedCategory = cleanCategory(category?.[1] || text);
  if (cleanedCategory && !/^(点东西|东西|一些东西|个东西|什么东西)$/.test(cleanedCategory)) result.extracted.category = cleanedCategory;
  const keywords = `${result.extracted.style || ''}${result.extracted.category || ''}${result.extracted.scene && !String(result.extracted.category || '').includes(result.extracted.scene) ? ` ${result.extracted.scene}` : ''}`.trim();
  result.extracted.keywords = keywords || text;
  result.query = result.extracted.keywords;
  return result;
}
