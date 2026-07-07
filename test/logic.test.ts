import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planTransfer } from '../src/bungie/actions.js';
import type { GhostItem } from '../src/bungie/profile.js';

function item(overrides: Partial<GhostItem>): GhostItem {
  return {
    itemInstanceId: '111',
    itemHash: 999,
    name: 'Fatebringer',
    itemType: 'Hand Cannon',
    tierType: 'Legendary',
    locked: false,
    equipped: false,
    location: { kind: 'vault' },
    plugHashes: [],
    ...overrides,
  };
}

test('planTransfer: vault→character is a single unvault step', () => {
  const steps = planTransfer(item({ location: { kind: 'vault' } }), 'charA');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].action, 'unvault');
  assert.equal(steps[0].characterId, 'charA');
});

test('planTransfer: char→char routes through the vault (two steps)', () => {
  const steps = planTransfer(item({ location: { kind: 'character', characterId: 'charA' } }), 'charB');
  assert.equal(steps.length, 2);
  assert.equal(steps[0].action, 'vault');
  assert.equal(steps[0].characterId, 'charA');
  assert.equal(steps[1].action, 'unvault');
  assert.equal(steps[1].characterId, 'charB');
});

test('planTransfer: already at destination is a no-op', () => {
  assert.equal(planTransfer(item({ location: { kind: 'vault' } }), 'vault').length, 0);
  assert.equal(
    planTransfer(item({ location: { kind: 'character', characterId: 'charA' } }), 'charA').length,
    0,
  );
});

test('planTransfer: equipped item to vault vaults from its character', () => {
  const steps = planTransfer(item({ location: { kind: 'equipped', characterId: 'charA' } }), 'vault');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].action, 'vault');
});
