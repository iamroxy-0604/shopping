import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('Usage: node validate.mjs <run directory>');
const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
assert.deepEqual(summary.A.batches[0].items.map((item) => item.id), summary.B.batches[0].items.map((item) => item.id));
for (const group of [summary.A, summary.B]) {
  assert(group.batches.every((batch) => batch.items.length === 3));
  const items = group.batches.flatMap((batch) => batch.items);
  assert.equal(new Set(items.map((item) => item.title)).size, items.length);
  assert.equal(group.status === 'success', group.batches.some((batch) => batch.satisfied));
  for (const batch of group.batches) {
    assert.equal(batch.satisfied, batch.items.some((item) => item.judgment.accepted));
  }
}
assert(events.some((event) => event.type === 'search_response' && event.ok && event.items.length > 0));
assert.equal(events.filter((event) => event.type === 'search_request').length, 3);
console.log(`Validated ${events.length} events, 2 groups, matching first batches, 3 live searches.`);
