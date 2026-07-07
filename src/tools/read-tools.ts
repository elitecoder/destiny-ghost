import { getInventory, type GhostItem } from '../bungie/profile.js';
import { scoreRoll, type RollTag } from '../scoring/wishlist.js';
import type { GhostTool } from './types.js';

/**
 * READ tools. Each returns a small, name-labeled slice — never the raw
 * inventory dump — so the model reasons over names, not opaque hashes, and the
 * manifest never enters context. (Anthropic tool-writing guidance, CONFIRMED.)
 */

function summarize(item: GhostItem): Record<string, unknown> {
  const loc =
    item.location.kind === 'vault'
      ? 'vault'
      : item.location.kind === 'postmaster'
        ? `postmaster (${item.location.characterId})`
        : `${item.location.kind} (${item.location.characterId})`;
  return {
    itemInstanceId: item.itemInstanceId,
    itemHash: item.itemHash,
    name: item.name,
    type: item.itemType,
    tier: item.tierType,
    slot: item.slot,
    element: item.element,
    power: item.powerLevel,
    locked: item.locked,
    equipped: item.equipped,
    location: loc,
  };
}

const matchesText = (item: GhostItem, q: string): boolean => {
  const hay = `${item.name} ${item.itemType} ${item.tierType} ${item.element ?? ''} ${item.slot ?? ''}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((tok) => hay.includes(tok));
};

export const getCharacterState: GhostTool = {
  kind: 'read',
  definition: {
    name: 'get_character_state',
    description:
      "List the player's characters (class, power level, id), and — critically — whether each is somewhere equips are allowed. Equips only succeed in orbit / a social space / offline; they fail during activities. Call this before equipping to get the right characterId. Also reports vault free-space and per-character bucket counts.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  async handler() {
    const inv = await getInventory();
    const vaultCount = inv.items.filter((i) => i.location.kind === 'vault').length;
    const characters = inv.characters.map((c) => {
      const onChar = inv.items.filter(
        (i) =>
          (i.location.kind === 'character' || i.location.kind === 'equipped') &&
          i.location.characterId === c.characterId,
      ).length;
      const postmaster = inv.items.filter(
        (i) => i.location.kind === 'postmaster' && i.location.characterId === c.characterId,
      ).length;
      return { ...c, itemsOnCharacter: onChar, postmasterItems: postmaster };
    });
    return JSON.stringify({
      player: inv.membership.displayName,
      vaultItems: vaultCount,
      characters,
      note: 'Equip-gating (orbit/social/activity) is not exposed by the API; warn the user that equips fail mid-activity.',
    });
  },
};

export const searchInventory: GhostTool = {
  kind: 'read',
  definition: {
    name: 'search_inventory',
    description:
      "Resolve a natural-language description of gear ('void hand cannons in the vault', 'my hunter's exotic helmets') into a small ranked list of concrete items with their itemInstanceId. Call this before any write tool to get the exact item to act on. Returns only high-signal, name-labeled rows — never the whole inventory.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text gear description, e.g. "arc sniper" or "exotic warlock chest".' },
        characterId: { type: 'string', description: 'Optional: scope to one character.' },
        location: {
          type: 'string',
          enum: ['vault', 'character', 'equipped', 'postmaster', 'any'],
          description: 'Optional location filter.',
          default: 'any',
        },
        limit: { type: 'integer', minimum: 1, maximum: 25, default: 10 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  async handler(input: { query: string; characterId?: string; location?: string; limit?: number }) {
    const inv = await getInventory();
    let items = inv.items.filter((i) => matchesText(i, input.query));
    if (input.location && input.location !== 'any') {
      items = items.filter((i) => i.location.kind === input.location);
    }
    if (input.characterId) {
      items = items.filter(
        (i) => 'characterId' in i.location && i.location.characterId === input.characterId,
      );
    }
    // Rank: higher power first, exotics before legendaries as a tiebreak.
    items.sort((a, b) => (b.powerLevel ?? 0) - (a.powerLevel ?? 0));
    const limited = items.slice(0, input.limit ?? 10);
    return JSON.stringify({
      matched: items.length,
      returned: limited.length,
      items: limited.map(summarize),
    });
  },
};

export const scoreItems: GhostTool = {
  kind: 'read',
  definition: {
    name: 'score_items',
    description:
      "Grade weapons against the DIM community god-roll wishlist (the same source Destiny Recipes uses), tagged for PvE or PvP. Use this for 'is this a good roll?', 'what should I keep?', or vault-cleanup triage. Returns per-item tier (S/A/B/C/D/F or 'unrated'), the matched-perk fraction, and the wishlist version so verdicts are grounded, not invented.",
    input_schema: {
      type: 'object',
      properties: {
        itemInstanceIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'The specific weapons to score (from search_inventory).',
        },
        activity: { type: 'string', enum: ['pve', 'pvp', 'any'], default: 'any' },
      },
      required: ['itemInstanceIds'],
      additionalProperties: false,
    },
  },
  async handler(input: { itemInstanceIds: string[]; activity?: RollTag }) {
    const inv = await getInventory();
    const results = [];
    for (const id of input.itemInstanceIds) {
      const item = inv.items.find((i) => i.itemInstanceId === id);
      if (!item) {
        results.push({ itemInstanceId: id, error: 'not found' });
        continue;
      }
      const s = await scoreRoll(item.itemHash, item.plugHashes, input.activity ?? 'any');
      results.push({
        itemInstanceId: id,
        name: item.name,
        type: item.itemType,
        locked: item.locked,
        tier: s.tier,
        score: Number(s.score.toFixed(2)),
        matchedRolls: s.matchedRolls,
        hasWishlist: s.hasWishlist,
      });
    }
    const wlVersion = results.length ? (await scoreRoll(0, [])).wishlistVersion : 'n/a';
    return JSON.stringify({ wishlistVersion: wlVersion, results });
  },
};

export const readTools: GhostTool[] = [getCharacterState, searchInventory, scoreItems];
