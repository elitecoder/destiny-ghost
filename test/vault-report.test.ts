import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  weaponDupeCounts,
  armorByClassSlot,
  lockTagContradictions,
  namedSetRisk,
  tierBreakdown,
  type VaultItem,
} from '../src/scoring/vault-report.js';

function item(over: Partial<VaultItem> & { itemInstanceId: string; name: string }): VaultItem {
  return {
    tierType: 'Legendary',
    itemType: 'Hand Cannon',
    classType: 3,
    locked: false,
    location: 'vault',
    ...over,
  };
}

test('weaponDupeCounts groups by name (not itemHash) and only surfaces 5+ copies', () => {
  const items: VaultItem[] = [
    ...Array.from({ length: 5 }, (_, i) => item({ itemInstanceId: `w${i}`, name: 'Sublimation' })),
    ...Array.from({ length: 3 }, (_, i) => item({ itemInstanceId: `x${i}`, name: 'Rare One' })),
  ];
  const rows = weaponDupeCounts(items);
  assert.deepEqual(rows.map((r) => r.name), ['Sublimation']);
  assert.equal(rows[0].total, 5);
});

test('weaponDupeCounts excludes armor and non-weapon item types', () => {
  const items: VaultItem[] = [
    ...Array.from({ length: 5 }, (_, i) => item({ itemInstanceId: `h${i}`, name: 'Some Helmet', itemType: 'Helmet' })),
    ...Array.from({ length: 5 }, (_, i) => item({ itemInstanceId: `e${i}`, name: 'Some Emblem', itemType: 'Emblem' })),
    ...Array.from({ length: 5 }, (_, i) => item({ itemInstanceId: `g${i}`, name: 'Real Gun' })),
  ];
  const rows = weaponDupeCounts(items);
  assert.deepEqual(rows.map((r) => r.name), ['Real Gun']);
});

test('weaponDupeCounts tracks untagged and locked counts, sorted by total desc', () => {
  const items: VaultItem[] = [
    ...Array.from({ length: 6 }, (_, i) =>
      item({ itemInstanceId: `a${i}`, name: 'Big Pile', locked: i < 2, tag: i < 3 ? 'keep' : undefined }),
    ),
    ...Array.from({ length: 5 }, (_, i) => item({ itemInstanceId: `b${i}`, name: 'Smaller Pile' })),
  ];
  const rows = weaponDupeCounts(items);
  assert.deepEqual(rows.map((r) => r.name), ['Big Pile', 'Smaller Pile']);
  assert.equal(rows[0].total, 6);
  assert.equal(rows[0].locked, 2);
  assert.equal(rows[0].untagged, 3);
});

test('armorByClassSlot groups by class and slot, aliasing class-item names to Class Armor', () => {
  const items: VaultItem[] = [
    item({ itemInstanceId: 'b1', name: 'A Bond', itemType: 'Warlock Bond', classType: 2, tag: 'keep', locked: true }),
    item({ itemInstanceId: 'b2', name: 'B Bond', itemType: 'Warlock Bond', classType: 2, tag: 'infuse' }),
    item({ itemInstanceId: 'c1', name: 'A Mark', itemType: 'Titan Mark', classType: 0 }),
  ];
  const rows = armorByClassSlot(items);
  const warlockClass = rows.find((r) => r.className === 'Warlock' && r.slot === 'Class Armor')!;
  assert.equal(warlockClass.total, 2);
  assert.equal(warlockClass.keep, 1);
  assert.equal(warlockClass.infusePending, 1);
  assert.equal(warlockClass.locked, 1);
  const titanClass = rows.find((r) => r.className === 'Titan' && r.slot === 'Class Armor')!;
  assert.equal(titanClass.total, 1);
  assert.equal(titanClass.untagged, 1);
});

test('lockTagContradictions finds junky-tagged items that are still locked, ignores keep/favorite', () => {
  const items: VaultItem[] = [
    item({ itemInstanceId: 'i1', name: 'Locked Infuse', locked: true, tag: 'infuse' }),
    item({ itemInstanceId: 'i2', name: 'Locked Junk', locked: true, tag: 'junk' }),
    item({ itemInstanceId: 'i3', name: 'Locked Keep', locked: true, tag: 'keep' }),
    item({ itemInstanceId: 'i4', name: 'Unlocked Infuse', locked: false, tag: 'infuse' }),
    item({ itemInstanceId: 'i5', name: 'Locked No Tag', locked: true }),
  ];
  const found = lockTagContradictions(items);
  assert.deepEqual(found.map((f) => f.itemInstanceId).sort(), ['i1', 'i2']);
});

test('namedSetRisk flags a set only when it spans 2+ slots AND has a junky-tagged piece', () => {
  const items: VaultItem[] = [
    item({ itemInstanceId: 's1', name: 'Thunderhead Boots', itemType: 'Leg Armor', classType: 2, tag: 'infuse', locked: true }),
    item({ itemInstanceId: 's2', name: 'Thunderhead Bond', itemType: 'Warlock Bond', classType: 2, tag: 'keep' }),
    // A single-slot "set" (only one slot owned) must not be flagged even if junky-tagged.
    item({ itemInstanceId: 's3', name: 'Lonesome Gloves', itemType: 'Gauntlets', classType: 2, tag: 'infuse' }),
  ];
  const risks = namedSetRisk(items);
  assert.equal(risks.length, 1);
  assert.equal(risks[0].setName, 'Thunderhead');
  assert.equal(risks[0].slotsOwned, 2);
  assert.deepEqual(risks[0].atRisk.map((a) => a.itemInstanceId), ['s1']);
});

test('namedSetRisk does not flag a set where nothing is junky-tagged', () => {
  const items: VaultItem[] = [
    item({ itemInstanceId: 's1', name: 'Smoke Jumper Boots', itemType: 'Leg Armor', classType: 1, tag: 'keep', locked: true }),
    item({ itemInstanceId: 's2', name: 'Smoke Jumper Cloak', itemType: 'Hunter Cloak', classType: 1, tag: 'keep', locked: true }),
  ];
  assert.deepEqual(namedSetRisk(items), []);
});

test('tierBreakdown counts instanced items per tier', () => {
  const items: VaultItem[] = [
    item({ itemInstanceId: 'l1', name: 'A', tierType: 'Legendary' }),
    item({ itemInstanceId: 'l2', name: 'B', tierType: 'Legendary' }),
    item({ itemInstanceId: 'e1', name: 'C', tierType: 'Exotic' }),
  ];
  assert.deepEqual(tierBreakdown(items), { Legendary: 2, Exotic: 1 });
});
