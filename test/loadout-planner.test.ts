import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  solveLoadout,
  ownStatsOf,
  maxModBonusOf,
  modsCanFill,
  type LoadoutPiece,
  type LoadoutTarget,
} from '../src/scoring/loadout-planner.js';
import type { ArmorStats } from '../src/bungie/profile.js';

const ZERO = { Weapons: 0, Health: 0, Class: 0, Grenade: 0, Super: 0, Melee: 0 };

function piece(
  over: { slot: LoadoutPiece['slot']; name: string; stats?: Partial<ArmorStats>; energyCapacity?: number; plugHashes?: number[]; isExotic?: boolean; gearTier?: number },
): LoadoutPiece {
  return {
    itemInstanceId: over.name,
    name: over.name,
    slot: over.slot,
    isExotic: over.isExotic ?? false,
    classType: 2,
    stats: { ...ZERO, ...(over.stats ?? {}) } as ArmorStats,
    energyCapacity: over.energyCapacity ?? 11,
    plugHashes: over.plugHashes ?? [],
    gearTier: over.gearTier,
  };
}

// ───────────────────────── pure helpers ─────────────────────────

test('ownStatsOf strips socketed stat mods so they can be re-planned', () => {
  // ItemStats reports Health 20, but a +5 Health minor mod (hash 2532323436) is socketed.
  const p = piece({
    name: 'H',
    slot: 'Helmet',
    stats: { Health: 20 },
    plugHashes: [2532323436],
  });
  assert.equal(ownStatsOf(p).Health, 15);
});

test('ownStatsOf ignores non-stat-mod plugs (e.g. combat mods)', () => {
  const p = piece({ name: 'H', slot: 'Helmet', stats: { Health: 12 }, plugHashes: [999999] });
  assert.equal(ownStatsOf(p).Health, 12);
});

test('maxModBonusOf: one stat mod per piece — major +10 if ≥3 energy, else minor +5', () => {
  assert.equal(maxModBonusOf(0), 0);
  assert.equal(maxModBonusOf(1), 5); // only a minor fits
  assert.equal(maxModBonusOf(2), 5);
  assert.equal(maxModBonusOf(3), 10); // a major fits
  assert.equal(maxModBonusOf(11), 10); // tier-5
});

test('modsCanFill: 5 stat-mod slots (one per piece), greedy largest-to-largest', () => {
  // 5 pieces all able to hold a major (+10 each) → 5 mods of +10.
  const fiveMajors = [10, 10, 10, 10, 10];
  // Two deficits of 20 each: 2 mods each = 4 mods total → feasible.
  assert.equal(modsCanFill({ ...ZERO, Health: 20, Grenade: 20 }, fiveMajors), true);
  // Three deficits of 20 each: 6 mods needed > 5 → infeasible.
  assert.equal(modsCanFill({ ...ZERO, Health: 20, Grenade: 20, Super: 20 }, fiveMajors), false);
  // One deficit of 50: all 5 majors to it → feasible (the cap).
  assert.equal(modsCanFill({ ...ZERO, Health: 50 }, fiveMajors), true);
  // One deficit of 60: exceeds 5×10 → infeasible.
  assert.equal(modsCanFill({ ...ZERO, Health: 60 }, fiveMajors), false);
  // Mixed piece budgets: [10,10,5,5,5] (35 total). Deficits 15+15 = 30, needs
  // 10+5 (2 mods) + 10+5 (2 mods) = 4 mods → feasible.
  assert.equal(modsCanFill({ ...ZERO, Health: 15, Grenade: 15 }, [10, 10, 5, 5, 5]), true);
  // Same budget, deficits 20+20 = 40 > 35 total → infeasible.
  assert.equal(modsCanFill({ ...ZERO, Health: 20, Grenade: 20 }, [10, 10, 5, 5, 5]), false);
});

// ───────────────────────── solveLoadout ─────────────────────────

function basicSet(): LoadoutPiece[] {
  return [
    piece({ name: 'Hel', slot: 'Helmet', stats: { Health: 10, Grenade: 10 } }),
    piece({ name: 'Gau', slot: 'Gauntlets', stats: { Health: 10, Grenade: 10 } }),
    piece({ name: 'Che', slot: 'Chest Armor', stats: { Health: 10, Grenade: 10 } }),
    piece({ name: 'Leg', slot: 'Leg Armor', stats: { Health: 10, Grenade: 10 } }),
    piece({ name: 'Cla', slot: 'Class Item', stats: {} }),
  ];
}

test('solveLoadout: feasible set hits targets with mods', () => {
  // 4 stat pieces give Health 40 / Grenade 40; target 60/60 needs +20 each → 8 energy.
  const req: LoadoutTarget = {
    classType: 2,
    exotic: 'none',
    target: { Health: 60, Grenade: 60 },
  };
  const r = solveLoadout(basicSet(), req);
  assert.equal(r.feasible, true);
  assert.ok(r.sets.length >= 1);
  const s = r.sets[0];
  assert.ok(s.finalStats.Health >= 60, `Health ${s.finalStats.Health} < 60`);
  assert.ok(s.finalStats.Grenade >= 60, `Grenade ${s.finalStats.Grenade} < 60`);
  assert.ok(s.energyUsed <= s.energyAvailable);
});

test('solveLoadout: globally impossible target returns NO + farm guidance', () => {
  const req: LoadoutTarget = {
    classType: 2,
    exotic: 'none',
    target: { Health: 200 }, // max achievable ≈ 40 + 75 = 115
  };
  const r = solveLoadout(basicSet(), req);
  assert.equal(r.feasible, false);
  assert.ok(r.guidance);
  assert.equal(r.guidance!.bottleneckStat, 'Health');
  assert.ok(r.guidance!.suggestedArchetypes.includes('Bulwark'));
  assert.ok(r.guidance!.message.length > 0);
});

test('solveLoadout: specific exotic locks its slot', () => {
  const pieces = [
    piece({ name: 'Exo Heart', slot: 'Chest Armor', stats: { Health: 25 }, isExotic: true }),
    piece({ name: 'Hel', slot: 'Helmet', stats: { Health: 10, Grenade: 10 } }),
    piece({ name: 'Gau', slot: 'Gauntlets', stats: { Health: 10, Grenade: 10 } }),
    piece({ name: 'Che', slot: 'Chest Armor', stats: { Health: 10, Grenade: 10 } }), // legendary chest
    piece({ name: 'Leg', slot: 'Leg Armor', stats: { Health: 10, Grenade: 10 } }),
    piece({ name: 'Cla', slot: 'Class Item', stats: {} }),
  ];
  const req: LoadoutTarget = {
    classType: 2,
    exotic: 'Exo Heart',
    target: { Health: 60, Grenade: 50 },
  };
  const r = solveLoadout(pieces, req);
  if (r.feasible) {
    const chest = r.sets[0].pieces.find((p) => p.slot === 'Chest Armor');
    assert.equal(chest?.name, 'Exo Heart');
  } else {
    // If not feasible, ensure the solver still ran and didn't error on the exotic.
    assert.ok(r.guidance || r.closest);
  }
});

test("solveLoadout: exotic 'any' tries each exotic-hosted variant and can pick the exotic when it's needed", () => {
  // Legendary-only max Health is 40 base + 50 mods = 90 — can't reach 95.
  // With the exotic chest (Health 25 instead of 10), base is 55 + 50 mods = 105.
  const pieces = [
    piece({ name: 'Exo Heart', slot: 'Chest Armor', stats: { Health: 25 }, isExotic: true }),
    piece({ name: 'Hel', slot: 'Helmet', stats: { Health: 10, Grenade: 10 } }),
    piece({ name: 'Gau', slot: 'Gauntlets', stats: { Health: 10, Grenade: 10 } }),
    piece({ name: 'Che', slot: 'Chest Armor', stats: { Health: 10, Grenade: 10 } }),
    piece({ name: 'Leg', slot: 'Leg Armor', stats: { Health: 10, Grenade: 10 } }),
    piece({ name: 'Cla', slot: 'Class Item', stats: {} }),
  ];
  const req: LoadoutTarget = { classType: 2, exotic: 'any', target: { Health: 95 } };
  const r = solveLoadout(pieces, req);
  assert.equal(r.feasible, true);
  const chest = r.sets[0].pieces.find((p) => p.slot === 'Chest Armor');
  assert.equal(chest?.name, 'Exo Heart', 'the exotic-hosted variant is required to reach 95 Health');
});

test("solveLoadout: exotic 'any' with no exotics owned falls back to the all-legendary variant", () => {
  const req: LoadoutTarget = { classType: 2, exotic: 'any', target: { Health: 60, Grenade: 60 } };
  const anyResult = solveLoadout(basicSet(), req);
  const noneResult = solveLoadout(basicSet(), { ...req, exotic: 'none' });
  assert.equal(anyResult.feasible, true);
  assert.deepEqual(anyResult.sets[0].finalStats, noneResult.sets[0].finalStats);
});

test('solveLoadout: unknown exotic name returns a clear guidance message', () => {
  const req: LoadoutTarget = { classType: 2, exotic: 'Does Not Exist', target: { Health: 60 } };
  const r = solveLoadout(basicSet(), req);
  assert.equal(r.feasible, false);
  assert.ok(r.guidance?.message.includes('Does Not Exist'));
});

test('solveLoadout: fragments are factored into the base totals', () => {
  // +10 Health fragment means the armor only needs to supply 50 of the 60 target.
  const req: LoadoutTarget = {
    classType: 2,
    exotic: 'none',
    target: { Health: 60 },
    fragments: { Health: 10 },
  };
  const r = solveLoadout(basicSet(), req);
  assert.equal(r.feasible, true);
  // base (armor) Health is 40; +10 fragment = 50; mod plan covers the remaining 10.
  assert.ok(r.sets[0].baseStats.Health >= 50);
});

test('solveLoadout: regression — a target met by summing base stats across slots (no mods) is not false-pruned', () => {
  // Each piece supplies Grenade 40 from base; 5 pieces = 200 with zero mods.
  // The old max-of-maxes bound saw "one slot 40 + mods 75 = 115 < 200" and pruned
  // the feasible branch. The sum-of-maxes bound correctly sees 5×40 = 200.
  const pieces = [
    piece({ name: 'Hel', slot: 'Helmet', stats: { Grenade: 40 } }),
    piece({ name: 'Gau', slot: 'Gauntlets', stats: { Grenade: 40 } }),
    piece({ name: 'Che', slot: 'Chest Armor', stats: { Grenade: 40 } }),
    piece({ name: 'Leg', slot: 'Leg Armor', stats: { Grenade: 40 } }),
    piece({ name: 'Cla', slot: 'Class Item', stats: { Grenade: 40 } }),
  ];
  const req: LoadoutTarget = { classType: 2, exotic: 'none', target: { Grenade: 200 } };
  const r = solveLoadout(pieces, req);
  assert.equal(r.feasible, true);
  assert.ok(r.sets[0].finalStats.Grenade >= 200);
  // No mods needed — the base already hits 200.
  assert.equal(r.sets[0].energyUsed, 0);
});

test('solveLoadout: named-set count constraints are enforced', () => {
  // Two named sets across slots; require 2 of each. Only the matching combination
  // satisfies it. Helmet has no "Alpha" piece, so Alpha must come from the other
  // 4 slots — exactly like the Smoke Jumper / Thunderhead case.
  const pieces = [
    piece({ name: 'Beta Helm', slot: 'Helmet', stats: { Grenade: 40 } }),
    piece({ name: 'Alpha Gauntlets', slot: 'Gauntlets', stats: { Grenade: 40 } }),
    piece({ name: 'Alpha Chest', slot: 'Chest Armor', stats: { Grenade: 40 } }),
    piece({ name: 'Beta Legs', slot: 'Leg Armor', stats: { Grenade: 40 } }),
    piece({ name: 'Beta Class', slot: 'Class Item', stats: { Grenade: 40 } }),
    // decoys that don't match a set
    piece({ name: 'Other Gauntlets', slot: 'Gauntlets', stats: { Grenade: 40 } }),
    piece({ name: 'Other Chest', slot: 'Chest Armor', stats: { Grenade: 40 } }),
  ];
  const req: LoadoutTarget = {
    classType: 2,
    exotic: 'none',
    target: { Grenade: 200 },
    setConstraints: [
      { name: 'Alpha', minCount: 2 },
      { name: 'Beta', minCount: 2 },
    ],
  };
  const r = solveLoadout(pieces, req);
  assert.equal(r.feasible, true);
  const set = r.sets[0];
  const alpha = set.pieces.filter((p) => p.name.includes('Alpha')).length;
  const beta = set.pieces.filter((p) => p.name.includes('Beta')).length;
  // Constraints are minCount (at least), not exact: Beta helm + Beta legs +
  // Beta class = 3 Beta is fine since minCount is 2.
  assert.ok(alpha >= 2, `alpha ${alpha} < 2`);
  assert.ok(beta >= 2, `beta ${beta} < 2`);
  assert.ok(set.finalStats.Grenade >= 200);
});

test('solveLoadout: unsatisfiable set constraints return NO with a set-constraint note', () => {
  const pieces = [
    piece({ name: 'Beta Helm', slot: 'Helmet', stats: { Grenade: 40 } }),
    piece({ name: 'Beta Gauntlets', slot: 'Gauntlets', stats: { Grenade: 40 } }),
    piece({ name: 'Beta Chest', slot: 'Chest Armor', stats: { Grenade: 40 } }),
    piece({ name: 'Beta Legs', slot: 'Leg Armor', stats: { Grenade: 40 } }),
    piece({ name: 'Beta Class', slot: 'Class Item', stats: { Grenade: 40 } }),
  ];
  // Require Alpha pieces that don't exist.
  const req: LoadoutTarget = {
    classType: 2,
    exotic: 'none',
    target: { Grenade: 200 },
    setConstraints: [{ name: 'Alpha', minCount: 2 }],
  };
  const r = solveLoadout(pieces, req);
  assert.equal(r.feasible, false);
  assert.ok(r.guidance?.message.toLowerCase().includes('alpha'));
});
