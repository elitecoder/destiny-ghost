import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planArmorKeepers, type ArmorPiece } from '../src/scoring/armor-planner.js';

const p = (id: string, archetype: string, total: number, tertiary: string): ArmorPiece => ({
  itemInstanceId: id,
  archetype,
  total,
  tertiary,
});

test('minTotal floor rejects a weak sole-tertiary piece (the T54 garbage bug)', () => {
  // Gunner with a lone +Health piece at T54 — under the old rule it was kept
  // "to fill the Health tertiary". The floor must reject it instead.
  const pieces = [
    p('super75', 'Gunner', 75, 'Super'),
    p('melee75', 'Gunner', 75, 'Melee'),
    p('health54', 'Gunner', 54, 'Health'), // sole Health, but garbage total
  ];
  const plan = planArmorKeepers(pieces, { keepArchetypes: ['Gunner'], minTotal: 73 });
  assert.deepEqual(plan.keepers.sort(), ['melee75', 'super75']);
  assert.ok(plan.rejects.includes('health54'), 'weak piece rejected despite unique tertiary');
  assert.deepEqual(plan.belowFloor, ['health54'], 'flagged as dropped-by-floor');
});

test('keeps top-1 per tertiary above the floor', () => {
  const pieces = [
    p('a', 'Grenadier', 75, 'Weapons'),
    p('b', 'Grenadier', 73, 'Weapons'), // same tertiary, lower — drop
    p('c', 'Grenadier', 75, 'Class'),
    p('d', 'Grenadier', 75, 'Melee'),
  ];
  const plan = planArmorKeepers(pieces, { keepArchetypes: ['Grenadier'], minTotal: 73 });
  assert.deepEqual(plan.keepers.sort(), ['a', 'c', 'd']);
  assert.ok(plan.rejects.includes('b'));
  assert.equal(plan.belowFloor.length, 0, 'b is a dup, not a floor drop');
});

test('archetypes not in keepArchetypes are fully rejected', () => {
  const pieces = [
    p('r1', 'Reaver', 75, 'Super'),
    p('r2', 'Reaver', 75, 'Health'),
    p('g1', 'Gunner', 75, 'Super'),
  ];
  const plan = planArmorKeepers(pieces, { keepArchetypes: ['Gunner'], minTotal: 73 });
  assert.deepEqual(plan.keepers, ['g1']);
  assert.deepEqual(plan.rejects.sort(), ['r1', 'r2']);
});

test('old armor (no archetype) is always rejected', () => {
  const pieces = [
    { itemInstanceId: 'old1', total: 89, tertiary: 'Health' }, // high total, but no archetype
    p('g1', 'Gunner', 75, 'Super'),
  ];
  const plan = planArmorKeepers(pieces, { keepArchetypes: ['Gunner'], minTotal: 73 });
  assert.deepEqual(plan.keepers, ['g1']);
  assert.ok(plan.rejects.includes('old1'), 'old armor rejected even at T89');
});

test('perTertiary=2 keeps two per tertiary above the floor', () => {
  const pieces = [
    p('a', 'Gunner', 75, 'Super'),
    p('b', 'Gunner', 74, 'Super'),
    p('c', 'Gunner', 73, 'Super'),
    p('d', 'Gunner', 72, 'Super'), // below floor → reject even as 3rd-best
  ];
  const plan = planArmorKeepers(pieces, { keepArchetypes: ['Gunner'], minTotal: 73, perTertiary: 2 });
  assert.deepEqual(plan.keepers.sort(), ['a', 'b']);
  assert.ok(plan.rejects.includes('c') && plan.rejects.includes('d'));
});
