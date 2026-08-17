import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseLightGgCombos,
  goodPerksFromCombos,
  reachableCombos,
  planKeepers,
  type CopyRolls,
} from '../src/scoring/keeper-planner.js';

// A minimal slice of light.gg's real DOM shape: eight Salvager's Salvo combos
// followed by stat-bar rows that must NOT parse as combos.
const SALVO_HTML = `
<div class="perk-names"><div>Trickle Charge</div><div>+ Gear Shift</div></div><div class="combo-percent">16.72% of Rolls</div>
<div class="perk-names"><div>Ambitious Assassin</div><div>+ Vorpal Weapon</div></div><div class="combo-percent">9.58% of Rolls</div>
<div class="perk-names"><div>Ambitious Assassin</div><div>+ Gear Shift</div></div><div class="combo-percent">6.8% of Rolls</div>
<div class="perk-names"><div>Demolitionist</div><div>+ Vorpal Weapon</div></div><div class="combo-percent">6.14% of Rolls</div>
<div class="perk-names"><div>Trickle Charge</div><div>+ Vorpal Weapon</div></div><div class="combo-percent">5.94% of Rolls</div>
<div class="perk-names"><div>Chain Reaction</div><div>+ Voltshot</div></div><div class="combo-percent">5.1% of Rolls</div>
<div class="perk-names"><div>Chain Reaction</div><div>+ Vorpal Weapon</div></div><div class="combo-percent">4.56% of Rolls</div>
<div class="perk-names"><div>Demolitionist</div><div>+ Gear Shift</div></div><div class="combo-percent">4.32% of Rolls</div>
<div class="perk-names"><div>Range</div></div><div class="combo-percent">.0%</div>
<div class="perk-names"><div>Stability</div></div><div class="combo-percent">.0%</div>
`;

test('parseLightGgCombos extracts only real two-perk combos, sorted by usage', () => {
  const combos = parseLightGgCombos(SALVO_HTML);
  assert.equal(combos.length, 8, 'stat-bar rows must not parse as combos');
  assert.deepEqual(combos[0], { trait1: 'Trickle Charge', trait2: 'Gear Shift', pct: 16.72 });
  assert.ok(combos[0].pct >= combos[7].pct, 'combos sorted descending by pct');
});

test('enhanced-perk asterisks are normalized so base rolls match', () => {
  // light.gg marks enhanced perks with "*". A copy rolling the base perk must
  // still match, or every combo reads as unreachable (the Voltaic Shade bug).
  const html = `
<div class="perk-names"><div>Jolting Feedback*</div><div>+ Voltshot*</div></div><div class="combo-percent">13.05% of Rolls</div>
`;
  const combos = parseLightGgCombos(html);
  assert.deepEqual(combos[0], { trait1: 'Jolting Feedback', trait2: 'Voltshot', pct: 13.05 });
  const copies: CopyRolls[] = [
    { itemInstanceId: 'X', powerLevel: 457, trait1Options: ['Jolting Feedback'], trait2Options: ['Voltshot', 'Frenzy'] },
  ];
  const { keepers } = planKeepers(copies, combos);
  assert.equal(keepers.length, 1, 'base perk should match the asterisked combo');
  assert.equal(keepers[0].itemInstanceId, 'X');
});

test('goodPerksFromCombos derives the good set ONLY from fetched combos', () => {
  const combos = parseLightGgCombos(SALVO_HTML);
  const good = goodPerksFromCombos(combos);
  // The perks light.gg actually shows.
  assert.ok(good.trait1.has('Trickle Charge'));
  assert.ok(good.trait1.has('Chain Reaction'));
  assert.ok(good.trait2.has('Vorpal Weapon'));
  assert.ok(good.trait2.has('Gear Shift'));
  // The hallucination guard: perks NOT in any fetched combo must be absent,
  // no matter how plausible they sound.
  assert.ok(!good.trait2.has('Collective Action'), 'Collective Action was never in the combos');
  assert.ok(!good.trait2.has('Rolling Storm'));
  assert.ok(!good.trait1.has('Withering Gaze'));
});

// The three Salvo copies from the real vault, reduced to trait options.
const COPIES: CopyRolls[] = [
  { itemInstanceId: 'A', powerLevel: 349, trait1Options: ['Demolitionist', 'Chain Reaction'], trait2Options: ['Vorpal Weapon', "Reaper's Tithe"] },
  { itemInstanceId: 'B', powerLevel: 445, trait1Options: ['Ambitious Assassin', 'Unrelenting'], trait2Options: ['Vorpal Weapon', "Reaper's Tithe"] },
  { itemInstanceId: 'C', powerLevel: 482, trait1Options: ['Demolitionist'], trait2Options: ['Gear Shift', 'Rolling Storm'] },
  // The Collective-Action copy: nice T1, but its T2 is never in any combo.
  { itemInstanceId: 'D', powerLevel: 471, trait1Options: ['Ambitious Assassin', 'Demolitionist', 'Trickle Charge'], trait2Options: ['Collective Action', 'Rolling Storm', "Reaper's Tithe"] },
];

test('reachableCombos only credits combos a copy can actually roll', () => {
  const combos = parseLightGgCombos(SALVO_HTML);
  const reachable = reachableCombos(COPIES, combos);
  // Copy D can form NO fetched combo — its T2 perks aren't in any combo.
  assert.equal(reachable.filter((r) => r.itemInstanceId === 'D').length, 0,
    'a copy whose perks never appear in a combo covers nothing');
  // Copy A rolls both Demo+Vorpal and ChainReaction+Vorpal.
  assert.equal(reachable.filter((r) => r.itemInstanceId === 'A').length, 2);
});

test('planKeepers with requiredAnyOf drops copies lacking a required perk (grenade gate)', () => {
  const combos = parseLightGgCombos(SALVO_HTML);
  // Two copies: one can roll Spike, one cannot. Both share a good trait combo.
  const glCopies: CopyRolls[] = [
    { itemInstanceId: 'SPIKE', powerLevel: 400, trait1Options: ['Demolitionist'], trait2Options: ['Gear Shift'], allOptions: ['Demolitionist', 'Gear Shift', 'Spike Grenades', 'Disorienting Grenades'] },
    { itemInstanceId: 'NONADE', powerLevel: 482, trait1Options: ['Demolitionist'], trait2Options: ['Gear Shift'], allOptions: ['Demolitionist', 'Gear Shift', 'High-Velocity Rounds', 'Implosion Rounds'] },
  ];
  const { keepers, ineligible } = planKeepers(glCopies, combos, ['Spike Grenades', 'Disorienting Grenades']);
  const keptIds = keepers.map((k) => k.itemInstanceId);
  // NONADE has the same trait combo but no usable grenade — gated out even
  // though it's higher power and would otherwise win the tie.
  assert.deepEqual(keptIds, ['SPIKE']);
  assert.deepEqual(ineligible, ['NONADE']);
});

test('planKeepers ties toward an already-locked copy over a higher-power unlocked one', () => {
  const combos = parseLightGgCombos(SALVO_HTML);
  // Both copies roll the exact same reachable combo (Demo+Gear Shift). UNLOCKED
  // has higher power, but LOCKED should still win the tie so we don't lock a
  // new copy when an existing locked one already covers the same ground.
  const copies: CopyRolls[] = [
    { itemInstanceId: 'LOCKED', powerLevel: 400, trait1Options: ['Demolitionist'], trait2Options: ['Gear Shift'], locked: true },
    { itemInstanceId: 'UNLOCKED', powerLevel: 482, trait1Options: ['Demolitionist'], trait2Options: ['Gear Shift'], locked: false },
  ];
  const { keepers } = planKeepers(copies, combos);
  assert.deepEqual(keepers.map((k) => k.itemInstanceId), ['LOCKED']);
});

test('planKeepers still breaks ties by power when neither or both copies are locked', () => {
  const combos = parseLightGgCombos(SALVO_HTML);
  // Neither locked: higher power wins, same as before the locked-preference fix.
  const neitherLocked: CopyRolls[] = [
    { itemInstanceId: 'LOW', powerLevel: 400, trait1Options: ['Demolitionist'], trait2Options: ['Gear Shift'] },
    { itemInstanceId: 'HIGH', powerLevel: 482, trait1Options: ['Demolitionist'], trait2Options: ['Gear Shift'] },
  ];
  assert.deepEqual(planKeepers(neitherLocked, combos).keepers.map((k) => k.itemInstanceId), ['HIGH']);

  // Both locked: higher power still wins the tie between two locked copies.
  const bothLocked: CopyRolls[] = [
    { itemInstanceId: 'LOW', powerLevel: 400, trait1Options: ['Demolitionist'], trait2Options: ['Gear Shift'], locked: true },
    { itemInstanceId: 'HIGH', powerLevel: 482, trait1Options: ['Demolitionist'], trait2Options: ['Gear Shift'], locked: true },
  ];
  assert.deepEqual(planKeepers(bothLocked, combos).keepers.map((k) => k.itemInstanceId), ['HIGH']);
});

test('planKeepers picks the minimal cover and never keeps the hallucination copy', () => {
  const combos = parseLightGgCombos(SALVO_HTML);
  const { keepers, unreachableCombos } = planKeepers(COPIES, combos);
  const keptIds = keepers.map((k) => k.itemInstanceId).sort();
  // A (Demo/CR + Vorpal), B (Ambitious + Vorpal), C (Demo + Gear Shift) cover
  // every reachable combo; D covers nothing and must be excluded.
  assert.deepEqual(keptIds, ['A', 'B', 'C']);
  assert.ok(!keptIds.includes('D'), 'the Collective Action copy is not a keeper');
  // Combos needing Voltshot / Trickle+Gear Shift etc. are unreachable — surfaced.
  const unreachableStr = unreachableCombos.map((c) => `${c.trait1}+${c.trait2}`);
  assert.ok(unreachableStr.includes('Chain Reaction+Voltshot'));
  assert.ok(unreachableStr.includes('Trickle Charge+Gear Shift'));
});
