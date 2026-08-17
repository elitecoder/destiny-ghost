import assert from 'node:assert/strict';
import { test } from 'node:test';
import { armorStatsFromComponent, STAT_ORDER, type ArmorStats } from '../src/bungie/profile.js';

/**
 * Build an ItemStats-shaped component from a partial stat map (hash → value).
 * Mimics Bungie's `{ [statHash]: { statHash, value } }` dictionary; keys are
 * stringified the way JSON parsing does, so we exercise the Number(key) path.
 */
function comp(stats: Record<number, number>): { stats: Record<number, { statHash: number; value: number }> } {
  const out: Record<number, { statHash: number; value: number }> = {};
  for (const [hash, value] of Object.entries(stats)) {
    out[Number(hash)] = { statHash: Number(hash), value };
  }
  return { stats: out };
}

test('armorStatsFromComponent maps the six armor stat hashes to Armor 3.0 names', () => {
  const stats = armorStatsFromComponent(
    comp({
      2996146975: 6, // Weapons (was Mobility)
      392767087: 12, // Health (was Resilience)
      1943323491: 10, // Class (was Recovery) — NOT the older 1943323000
      1735777505: 2, // Grenade (was Discipline)
      144602215: 2, // Super (was Intellect)
      4244567218: 6, // Melee (was Strength)
    }),
  )!;
  assert.deepEqual(stats, {
    Weapons: 6,
    Health: 12,
    Class: 10,
    Grenade: 2,
    Super: 2,
    Melee: 6,
  } as ArmorStats);
});

test('armorStatsFromComponent pins Class (was Recovery) to hash 1943323491, not the legacy 1943323000', () => {
  // The legacy/older Recovery hash must NOT be recognized.
  const wrong = armorStatsFromComponent(comp({ 1943323000: 20 }));
  assert.equal(wrong, undefined, 'legacy Recovery hash 1943323000 should not map to any stat');

  const right = armorStatsFromComponent(comp({ 1943323491: 20 }))!;
  assert.equal(right.Class, 20);
  assert.equal(STAT_ORDER[2], 'Class');
});

test('armorStatsFromComponent ignores non-armor stats (e.g. weapon Attack/Defense hashes)', () => {
  // 4284893193 is "Defense" (armor power); 2996146975 is Weapons. Only armor stats survive.
  const stats = armorStatsFromComponent(comp({ 4284893193: 1810, 2996146975: 7 }))!;
  assert.equal(stats.Weapons, 7);
  // every other armor stat is 0 (the unknown Defense hash is dropped)
  assert.equal(stats.Health, 0);
  assert.equal(stats.Melee, 0);
});

test('armorStatsFromComponent returns undefined when no armor stats are present (weapons)', () => {
  assert.equal(armorStatsFromComponent(comp({ 4284893193: 1810, 1480404414: 1400 })), undefined);
  assert.equal(armorStatsFromComponent(undefined), undefined);
  assert.equal(armorStatsFromComponent({}), undefined);
});
