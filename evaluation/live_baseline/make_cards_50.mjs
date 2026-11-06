import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scenarios = JSON.parse(fs.readFileSync(path.join(here, 'scenarios_50.json'), 'utf8'));
const lines = ['# 50 条充电宝购买需求材料', '', '每条公开需求在 A、B 两组中完全相同。隐藏条件与 B 组反馈顺序均在运行前固定。此表是实验材料，不代表这些商品条件已经在淘宝详情中核实。', '', '| 编号 | 情境 | 公开的初始需求 | 隐藏的必须条件 | B 组按序补充 |', '| --- | --- | --- | --- | --- |'];
for (const s of scenarios) {
  const safe = (text) => String(text).replaceAll('|', '\\|');
  lines.push(`| ${s.id} | ${s.scene} | ${safe(s.initialRequest)} | ${s.hard.map((x) => safe(x.text)).join('；')} | ${s.feedback.map((x) => safe(x.message)).join(' → ')} |`);
}
fs.writeFileSync(path.join(here, 'CARDS_50.md'), lines.join('\n') + '\n');
console.log('Saved 50-card review table.');
