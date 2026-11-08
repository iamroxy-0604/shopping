# 充电宝推荐基线实验简报（50 条需求）

**运行日期：**2026 年 11 月 6 日（北京时间）

**有效数据：**`runs/2026-11-06T08-34-32-644Z/`

## 目的与设置

比较两种无主动追问的反馈方式：A 组每轮只说“满意/不满意”；B 组在不满意后按预定顺序补充一项需求。事先固定 50 条充电宝购买需求，分属 10 种使用情境；每条均有容量、功能或规格、价格三项隐藏条件。每条分别运行 A、B，首批商品相同，每批 3 件，最多 5 批。商品来自实时淘宝联盟搜索；用户反馈由脚本模拟。

## 结果

| 指标 | A 组 | B 组 |
| --- | ---: | ---: |
| 5 批内出现标题与接口价格匹配的候选 | 7/50 | 14/50 |
| 首批出现候选 | 3/50 | 3/50 |
| 累计展示批次 | 228 | 205 |
| 累计补充需求 | 0 | 119 |

100 次交互全部完成；共展示 433 批、1299 件次。414 次淘宝请求无接口错误。两组都检出候选的 7 条中，5 条批次相同、2 条 B 提前 1 批；另有 7 条仅 B 检出，36 条两组均未检出。1945 条原始事件及全部逐批结果已保存。校验确认同一需求的两组首批一致、每批恰好 3 件、同组无重复标题。

## 测试代码逻辑（节选）

**1. 固定首批与批次数。**每条需求先完成共享检索，再分别进入两组，保证起点相同。

```js
const maxBatches = 5;
const batchSize = 3;
first.items = sharedPool;
const A = await runGroup(s, 'A', first);
const B = await runGroup(s, 'B', first);
```

**2. B 组按预定反馈更新检索。**A 组保持原始需求，继续取新商品；B 组只使用已补充的条件。

```js
if (n > 1 && group === 'B' && feedback.length) {
  const last = feedback.at(-1);
  if (last.queryTerm && !query.includes(last.queryTerm)) query += ` ${last.queryTerm}`;
  if (last.maxPrice !== undefined) maxPrice = last.maxPrice;
  pool = [];
  cursor = 0;
  pageNo = 1;
}
```

**3. 排除重复并判定候选。**逐件检查接口价格和卖家标题；全部匹配才列为待核查候选，仍不计作确认满意。

```js
let displayed = uniqueCandidates(pool.slice(cursor), shownIds, shownProducts, [], batchSize);
const items = displayed.map((item) => ({ ...publicItem(item), judgment: judge(item, s.hard) }));
const proxy = items.find((item) => item.judgment.proxyCandidate);
if (proxy) { stopReason = 'proxy_candidate_found_requires_human_review'; break; }
```

完整代码见 `run_v2.mjs`；逐项判定的 `judge()` 将价格标为接口证据、标题字样标为候选证据，缺少详情的条件标为未知。

## 结论与边界

按**标题与接口价格候选检出**的口径，B 组比 A 组多检出 7 条，方向符合补充需求有助于检索的预期；代价是额外 119 次用户信息输入。**这不是满意率或下单率。**商品详情尚未核对功率、重量、接口、认证、兼容性和实际所选规格价格；21 条候选记录均待人工复核，未检出候选也不等于商品库没有合格商品。

这 50 条是人工组合的便利样本，且全部恰有三个隐藏条件，B 组最迟到第 4 批前即可透露全部条件。该设置会给 B 组结构性的信息优势。本轮运行的是独立检索脚本，不是现有会主动问卷的 Wit 智能体。正式的成功率及统计结论需要先核实商品详情和材料可行性，再按同一满意规则重跑。
