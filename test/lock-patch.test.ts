import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyLockPatch, type GhostInventory, type GhostItem } from '../src/bungie/profile.js';

function item(id: string, locked: boolean): GhostItem {
  return {
    itemInstanceId: id,
    itemHash: 1,
    name: 'Voltaic Shade',
    itemType: 'Scout Rifle',
    tierType: 'Legendary',
    locked,
    equipped: false,
    location: { kind: 'vault' },
    plugHashes: [],
    perkColumns: [],
  };
}

function inv(...items: GhostItem[]): GhostInventory {
  return {
    membership: { membershipType: 3, membershipId: '1', displayName: 'Guardian' },
    characters: [],
    items,
    fetchedAt: 0,
  };
}

test('applyLockPatch flips the cached lock state in place', () => {
  // Reproduces the Voltaic bug: a just-locked item read back from the cached
  // snapshot must reflect the new lock state, not the stale pre-lock value.
  const snapshot = inv(item('A', false), item('B', false));
  const ok = applyLockPatch(snapshot, 'A', true);
  assert.equal(ok, true);
  assert.equal(snapshot.items.find((i) => i.itemInstanceId === 'A')!.locked, true, 'A now reads locked');
  assert.equal(snapshot.items.find((i) => i.itemInstanceId === 'B')!.locked, false, 'B untouched');
});

test('applyLockPatch can also unlock', () => {
  const snapshot = inv(item('A', true));
  applyLockPatch(snapshot, 'A', false);
  assert.equal(snapshot.items[0].locked, false);
});

test('applyLockPatch returns false for an unknown item', () => {
  const snapshot = inv(item('A', false));
  assert.equal(applyLockPatch(snapshot, 'MISSING', true), false);
});
