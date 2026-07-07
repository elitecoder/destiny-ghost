import {
  executeTransfer,
  equipOne,
  planTransfer,
  pullPostmaster,
  setLock,
} from '../bungie/actions.js';
import { getInventory, type GhostItem } from '../bungie/profile.js';
import type { GhostTool } from './types.js';

/**
 * WRITE tools. Each one does NOT mutate the account directly — it computes a
 * plan and registers a PendingAction via ctx.propose(). The server surfaces the
 * plan as a confirm dialog; the account changes only when the user confirms and
 * the action's execute() runs. There is deliberately no dismantle/delete tool —
 * the Bungie API exposes none, and we never synthesize one.
 */

async function requireItem(id: string): Promise<GhostItem> {
  const inv = await getInventory({ force: true });
  const item = inv.items.find((i) => i.itemInstanceId === id);
  if (!item) throw new Error(`No item with instance id ${id} in inventory.`);
  return item;
}

export const transferItemTool: GhostTool = {
  kind: 'write',
  definition: {
    name: 'transfer_item',
    description:
      "Move an item to the vault or to a specific character. Character-to-character moves are NOT one API call — they route through the vault, so this returns a multi-step plan. Nothing moves until the user confirms.",
    input_schema: {
      type: 'object',
      properties: {
        itemInstanceId: { type: 'string' },
        destination: { type: 'string', description: "'vault' or a target characterId (from get_character_state)." },
      },
      required: ['itemInstanceId', 'destination'],
      additionalProperties: false,
    },
  },
  async handler(input: { itemInstanceId: string; destination: string }, ctx) {
    const item = await requireItem(input.itemInstanceId);
    const steps = planTransfer(item, input.destination);
    if (steps.length === 0) return `${item.name} is already at the requested destination — nothing to do.`;
    const plan = steps.map((s) => s.description);
    const token = ctx.propose({
      tool: 'transfer_item',
      summary: `Move ${item.name} → ${input.destination === 'vault' ? 'vault' : 'character ' + input.destination}`,
      plan,
      execute: async () => {
        const done = await executeTransfer(input.itemInstanceId, input.destination);
        return done.length ? `Done:\n- ${done.join('\n- ')}` : 'Already in place.';
      },
    });
    return `Proposed (awaiting confirmation ${token}):\n- ${plan.join('\n- ')}`;
  },
};

export const equipItemTool: GhostTool = {
  kind: 'write',
  definition: {
    name: 'equip_item',
    description:
      'Equip a single item on the character it is currently on. Fails if the character is mid-activity. Nothing changes until the user confirms.',
    input_schema: {
      type: 'object',
      properties: { itemInstanceId: { type: 'string' } },
      required: ['itemInstanceId'],
      additionalProperties: false,
    },
  },
  async handler(input: { itemInstanceId: string }, ctx) {
    const item = await requireItem(input.itemInstanceId);
    const loc = item.location;
    if (loc.kind === 'vault') {
      return `${item.name} is in the vault — transfer it to a character first, then equip.`;
    }
    const characterId = 'characterId' in loc ? loc.characterId : undefined;
    if (!characterId) return `Cannot determine which character holds ${item.name}.`;
    const token = ctx.propose({
      tool: 'equip_item',
      summary: `Equip ${item.name}`,
      plan: [`Equip ${item.name} on character ${characterId} (must be in orbit/social, not in an activity)`],
      execute: async () => {
        await equipOne(item, characterId);
        return `Equipped ${item.name}.`;
      },
    });
    return `Proposed (awaiting confirmation ${token}): Equip ${item.name}.`;
  },
};

export const setLockTool: GhostTool = {
  kind: 'write',
  definition: {
    name: 'set_lock',
    description:
      "Lock or unlock a specific item. This is the vault-cleanup primitive: lock keepers so they can't be accidentally dismantled in-game, unlock rejects so you can bulk-dismantle them yourself in-game. Reversible; low-risk. Note: this does NOT dismantle — the Bungie API has no delete endpoint, so the user always does the actual dismantle in-game.",
    input_schema: {
      type: 'object',
      properties: {
        itemInstanceId: { type: 'string' },
        locked: { type: 'boolean' },
      },
      required: ['itemInstanceId', 'locked'],
      additionalProperties: false,
    },
  },
  async handler(input: { itemInstanceId: string; locked: boolean }, ctx) {
    const item = await requireItem(input.itemInstanceId);
    if (item.locked === input.locked) return `${item.name} is already ${input.locked ? 'locked' : 'unlocked'}.`;
    const loc = item.location;
    const characterId = 'characterId' in loc ? loc.characterId : (await getInventory()).characters[0]?.characterId;
    if (!characterId) return 'No character available to perform the lock action.';
    const verb = input.locked ? 'Lock' : 'Unlock';
    const token = ctx.propose({
      tool: 'set_lock',
      summary: `${verb} ${item.name}`,
      plan: [`${verb} ${item.name}`],
      execute: async () => {
        await setLock(item, characterId, input.locked);
        return `${verb}ed ${item.name}.`;
      },
    });
    return `Proposed (awaiting confirmation ${token}): ${verb} ${item.name}.`;
  },
};

export const pullPostmasterTool: GhostTool = {
  kind: 'write',
  definition: {
    name: 'pull_postmaster',
    description:
      'Pull an item from the postmaster onto its character. The character needs a free slot in that bucket, or the pull fails. Nothing changes until the user confirms.',
    input_schema: {
      type: 'object',
      properties: { itemInstanceId: { type: 'string' } },
      required: ['itemInstanceId'],
      additionalProperties: false,
    },
  },
  async handler(input: { itemInstanceId: string }, ctx) {
    const item = await requireItem(input.itemInstanceId);
    if (item.location.kind !== 'postmaster') return `${item.name} is not in the postmaster.`;
    const characterId = item.location.characterId;
    const token = ctx.propose({
      tool: 'pull_postmaster',
      summary: `Pull ${item.name} from the postmaster`,
      plan: [`Pull ${item.name} from the postmaster onto character ${characterId} (needs a free slot)`],
      execute: async () => {
        await pullPostmaster(item, characterId);
        return `Pulled ${item.name} from the postmaster.`;
      },
    });
    return `Proposed (awaiting confirmation ${token}): Pull ${item.name} from the postmaster.`;
  },
};

export const writeTools: GhostTool[] = [
  transferItemTool,
  equipItemTool,
  setLockTool,
  pullPostmasterTool,
];
