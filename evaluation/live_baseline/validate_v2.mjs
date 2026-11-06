import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('Usage: node validate_v2.mjs <run directory>');
const scenarios = JSON.parse(fs.readFileSync(path.join(dir, 'scenarios_snapshot.json'), 'utf8'));
const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
assert.equal(summary.results.length, scenarios.length);
assert.equal(summary.pairedRunsCompleted, scenarios.length);
for (const r of summary.results) {
  assert(r.A && r.B, `Missing pair for ${r.scenarioId}`);
  assert.deepEqual(r.A.batches[0].items.map((x) => x.title), r.B.batches[0].items.map((x) => x.title));
  for (const group of [r.A, r.B]) {
    assert(group.batches.length <= 5);
    assert(group.batches.every((b) => b.items.length === 3), `${r.scenarioId}/${group.group}: incomplete batch`);
    const titles = group.batches.flatMap((b) => b.items.map((x) => x.title));
    assert.equal(new Set(titles).size, titles.length, `${r.scenarioId}/${group.group}: duplicate title`);
    assert(group.batches.every((b) => b.items.every((x) => !x.judgment.confirmedSatisfied)));
    assert.equal(group.proxyCandidateBatch !== null, group.batches.some((b) => b.proxyCandidateId));
  }
}
assert(events.some((e) => e.type === 'search_response' && e.ok && e.count > 0));
const calls = events.filter((e) => e.type === 'search_request').length;
console.log(`Validated ${scenarios.length} paired scenarios, ${scenarios.length * 2} groups, ${events.length} events, ${calls} live search calls.`);
