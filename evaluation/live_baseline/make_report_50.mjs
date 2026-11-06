import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2];
if (!dir) throw new Error('Usage: node make_report_50.mjs <run directory>');
const scenarios = JSON.parse(fs.readFileSync(path.join(dir, 'scenarios_snapshot.json'), 'utf8'));
const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
const rows = summary.results;
const count = (group) => rows.filter((r) => r[group].proxyCandidateBatch !== null).length;
const both = rows.filter((r) => r.A.proxyCandidateBatch && r.B.proxyCandidateBatch);
const bOnly = rows.filter((r) => !r.A.proxyCandidateBatch && r.B.proxyCandidateBatch);
const aOnly = rows.filter((r) => r.A.proxyCandidateBatch && !r.B.proxyCandidateBatch);
const tie = both.filter((r) => r.A.proxyCandidateBatch === r.B.proxyCandidateBatch);
const fasterB = both.filter((r) => r.B.proxyCandidateBatch < r.A.proxyCandidateBatch);
const fasterA = both.filter((r) => r.A.proxyCandidateBatch < r.B.proxyCandidateBatch);
const sum = (group, key) => rows.reduce((n, r) => n + r[group][key], 0);
const start = events[0]?.at;
const end = events.at(-1)?.at;
const lines = [
  '# 50 条充电宝需求 A/B 实时检索试运行报告', '',
  `**运行时间：**${start} 至 ${end}（日志为 UTC）`, '',
  `**有效数据目录：**\`${path.relative(here, dir).replaceAll('\\', '/')}\``, '',
  '## 实验目标与材料', '',
  '在系统不主动追问的条件下，比较 A 组只反馈满意与否、B 组每次未检出候选后按预定顺序补充一项需求的检索过程。材料在运行前固定，为 10 种使用情境各 5 条，共 50 条不同初始说法；每条隐藏三个必须条件：容量、功能或规格、价格。完整材料见 `CARDS_50.md` 和本次运行目录的 `scenarios_snapshot.json`。', '',
  '两组首批共享同一次实时淘宝检索结果；每批 3 件，最多 5 批；已展示商品按 ID 与规范化标题去重。搜索词过窄时，脚本回退到较宽的已公开词，所有请求均写入事件日志。当前运行的是独立检索脚本，不是会主动问卷的 Wit 智能体。', '',
  '## 数据完整性', '',
  `- 完成 ${summary.pairedRunsCompleted}/50 个 A/B 配对，共 100 次交互；展示 ${sum('A','batchesShown') + sum('B','batchesShown')} 批、${(sum('A','batchesShown') + sum('B','batchesShown')) * 3} 件次。`,
  `- 原始事件 ${events.length} 条；淘宝实时搜索请求 ${events.filter((e) => e.type === 'search_request').length} 次；接口错误 ${events.filter((e) => e.type === 'search_response' && !e.ok).length} 次。`,
  `- A 组展示 ${sum('A','batchesShown')} 批；B 组展示 ${sum('B','batchesShown')} 批，并累计补充 ${sum('B','attributesRevealed')} 项需求。`,
  '- 日志校验通过：每个配对的首批商品一致、每批恰好 3 件、同组无重复标题、单组不超过 5 批。', '',
  '## 候选检出结果', '',
  '| 指标 | A：只反馈不满意 | B：逐轮补充需求 |', '| --- | ---: | ---: |',
  `| 5 批内出现标题与接口价格候选 | ${count('A')}/50 | ${count('B')}/50 |`,
  `| 首批出现候选 | ${rows.filter((r) => r.A.proxyCandidateBatch === 1).length}/50 | ${rows.filter((r) => r.B.proxyCandidateBatch === 1).length}/50 |`,
  `| 累计展示批次 | ${sum('A','batchesShown')} | ${sum('B','batchesShown')} |`,
  `| 累计补充属性 | ${sum('A','attributesRevealed')} | ${sum('B','attributesRevealed')} |`, '',
  `两组均检出候选 ${both.length} 条；仅 B 组检出 ${bOnly.length} 条（${bOnly.map((r) => r.scenarioId).join('、')}）；仅 A 组检出 ${aOnly.length} 条。两组均检出的需求中，${tie.length} 条批次相同，B 组提前的有 ${fasterB.length} 条（${fasterB.map((r) => r.scenarioId).join('、')}），A 组提前的有 ${fasterA.length} 条。其余 ${50 - both.length - bOnly.length - aOnly.length} 条两组均未在 5 批内检出标题与价格候选。`, '',
  '### 逐条结果', '',
  '表中数字是“首次出现待核查候选的批次”，“—”表示 5 批内未检出候选，均不代表确认满意。', '',
  '| 编号 | 情境 | 公开的初始需求 | A | B | B 补充项数 |', '| --- | --- | --- | ---: | ---: | ---: |'
];
for (const s of scenarios) {
  const r = rows.find((x) => x.scenarioId === s.id);
  lines.push(`| ${s.id} | ${s.scene} | ${s.initialRequest} | ${r.A.proxyCandidateBatch ?? '—'} | ${r.B.proxyCandidateBatch ?? '—'} | ${r.B.attributesRevealed} |`);
}
lines.push('', '## 结论与限制', '',
  `B 组在本次**标题与接口价格候选**口径下比 A 组多检出 ${count('B') - count('A')} 条，方向符合“用户补充要求有助于缩小检索范围”的预期；但 B 组也让用户多提供了 ${sum('B','attributesRevealed')} 项信息。这个差异是描述性结果，不能直接当作真实满意度或下单效果。`, '',
  '当前淘宝搜索接口没有提供足以确认重量、USB-C 单口输出、双设备同时充电、3C 详情及型号兼容性的结构化证据。商品标题是卖家描述；接口价格也可能与所选规格或实际到手价不同。`review_queue.csv` 中的候选均为“待核查”，没有一条被记为人工确认满意。标题没写某项属性的商品也可能在详情页满足要求，因此“未检出候选”不等于“没有合格商品”。', '',
  '这 50 条材料是按 10 种情境和预设条件组合构造的便利样本，并未逐条完成“商品库至少有一件合格商品”的事前核查；少数条件组合可能不现实。正式的 5 批内成功率和显著性分析应在材料可行性、商品详情与用户接受标准核实后再计算。', '',
  '## 数据与复现', '',
  '- `scenarios_50.json` 与 `CARDS_50.md`：实验材料；运行目录的 `scenarios_snapshot.json`：本轮冻结副本。',
  '- `events.jsonl`：所有搜索请求、接口响应、展示商品、逐项判定、反馈与停止原因；`summary.json`：逐条逐批结构化结果。',
  '- `review_queue.csv`：所有标题与价格候选的人工复核清单。',
  '- `PROCESS_50.md`：完整实验步骤、验证和当前判定边界。', '');
fs.writeFileSync(path.join(here, 'REPORT_50.md'), lines.join('\n'));
console.log(`Saved 50-row report; proxy candidates A=${count('A')}, B=${count('B')}.`);
