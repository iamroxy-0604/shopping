import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('Usage: node make_review_queue.mjs <run directory>');
const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
const rows = [];
for (const result of summary.results) {
  for (const group of [result.A, result.B]) {
    const batch = group.batches.find((b) => b.proxyCandidateId);
    if (!batch) continue;
    const item = batch.items.find((x) => x.id === batch.proxyCandidateId);
    rows.push({ scenarioId: result.scenarioId, group: group.group, batch: batch.number, itemId: item.id,
      title: item.title, apiPriceYuan: item.price, decision: '待核查', detailEvidence: '', reviewer: '', reviewNotes: '' });
  }
}
const csv = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
const columns = ['scenarioId','group','batch','itemId','title','apiPriceYuan','decision','detailEvidence','reviewer','reviewNotes'];
fs.writeFileSync(path.join(dir, 'review_queue.csv'), '\uFEFF' + columns.map(csv).join(',') + '\n' + rows.map((row) => columns.map((col) => csv(row[col])).join(',')).join('\n') + '\n');
console.log(`Saved ${rows.length} candidate rows for human review.`);
