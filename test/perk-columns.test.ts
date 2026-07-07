import assert from 'node:assert/strict';
import { test } from 'node:test';
import { columnsFromSockets } from '../src/bungie/profile.js';

// Synthetic perk hashes → names, mirroring a gear-tier Convened Recurve copy
// where each trait column has 3 selectable options.
const NAMES: Record<number, string> = {
  1: 'Successful Warm-Up',
  2: 'Withering Gaze',
  3: 'Moving Target',
  4: 'Destabilizing Rounds',
  5: 'Butterfly',
  6: 'Demoralize',
  10: 'High-Impact Longbow', // intrinsic
};
const name = (h: number) => NAMES[h] ?? `?${h}`;

test('columnsFromSockets exposes ALL selectable options, not just the equipped perk', () => {
  // Sockets 3 and 4 are the two trait columns; each has 3 reusable options.
  const perkIndexes = [3, 4];
  const selected = { 3: 1, 4: 4 }; // equipped: SWU, Destabilizing Rounds
  const options = {
    3: [1, 2, 3], // SWU / Withering Gaze / Moving Target
    4: [4, 5, 6], // Destabilizing Rounds / Butterfly / Demoralize
  };

  const cols = columnsFromSockets(perkIndexes, selected, options, name);

  assert.equal(cols.length, 2);
  assert.equal(cols[0].selected, 'Successful Warm-Up');
  assert.deepEqual(cols[0].options, ['Successful Warm-Up', 'Withering Gaze', 'Moving Target']);
  assert.deepEqual(cols[1].options, ['Destabilizing Rounds', 'Butterfly', 'Demoralize']);

  // The regression guard: a column must expose MORE than the equipped perk when
  // the copy can roll to others. Deduping on `selected` alone was the bug.
  assert.ok(
    cols.every((c) => c.options.length > 1),
    'each trait column should surface every swappable option',
  );
});

test('columnsFromSockets falls back to the selected plug for a fixed column', () => {
  // A column with no reusable list (fixed perk) should still report one option.
  const cols = columnsFromSockets([3], { 3: 6 }, { 3: [] }, name);
  assert.equal(cols.length, 1);
  assert.equal(cols[0].selected, 'Demoralize');
  assert.deepEqual(cols[0].options, ['Demoralize']);
});

test('columnsFromSockets skips empty columns (no selected, no options)', () => {
  const cols = columnsFromSockets([3, 4], { 3: 1 }, { 3: [1, 2] }, name);
  // Index 4 has neither a selected plug nor options → dropped.
  assert.equal(cols.length, 1);
});
