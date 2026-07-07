import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ensureManifest } from '../bungie/manifest.js';
import { getInventory, type GhostItem } from '../bungie/profile.js';
import {
  equipOne,
  executeTransfer,
  planTransfer,
  pullPostmaster,
  setLock,
} from '../bungie/actions.js';
import { scoreRoll, type RollTag } from '../scoring/wishlist.js';

/**
 * Destiny Ghost MCP server. Exposes the Bungie read/write operations as tools
 * for an MCP client (Claude) to call. The confirmation gate now lives in the
 * CLIENT: write tools default to dry_run=true (return a plan, mutate nothing);
 * the Skill instructs the model to preview, get the user's explicit yes, then
 * call again with dry_run=false. There is no dismantle tool — the API has none.
 */

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

function locationLabel(item: GhostItem): string {
  const loc = item.location;
  if (loc.kind === 'vault') return 'vault';
  if (loc.kind === 'postmaster') return `postmaster (${loc.characterId})`;
  return `${loc.kind} (${loc.characterId})`;
}

function summarize(item: GhostItem): Record<string, unknown> {
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
    location: locationLabel(item),
  };
}

const matchesText = (item: GhostItem, q: string): boolean => {
  const hay = `${item.name} ${item.itemType} ${item.tierType} ${item.element ?? ''} ${item.slot ?? ''}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((tok) => hay.includes(tok));
};

async function requireItem(id: string): Promise<GhostItem> {
  const inv = await getInventory({ force: true });
  const item = inv.items.find((i) => i.itemInstanceId === id);
  if (!item) throw new Error(`No item with instance id ${id} in inventory.`);
  return item;
}

const server = new McpServer({ name: 'destiny-ghost', version: '0.2.0' });

// ─────────────────────────────── READ TOOLS ───────────────────────────────

server.registerTool(
  'get_character_state',
  {
    description:
      "List the player's characters (class, power, id), vault free-space, and per-character item + postmaster counts. Call before equipping to get the right characterId. Note: equips only succeed in orbit/social/offline, never mid-activity — the API doesn't expose activity state, so warn the user.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const inv = await getInventory();
    const vaultCount = inv.items.filter((i) => i.location.kind === 'vault').length;
    const characters = inv.characters.map((c) => ({
      ...c,
      itemsOnCharacter: inv.items.filter(
        (i) => (i.location.kind === 'character' || i.location.kind === 'equipped') && 'characterId' in i.location && i.location.characterId === c.characterId,
      ).length,
      postmasterItems: inv.items.filter(
        (i) => i.location.kind === 'postmaster' && i.location.characterId === c.characterId,
      ).length,
    }));
    return text(JSON.stringify({ player: inv.membership.displayName, vaultItems: vaultCount, characters }, null, 2));
  },
);

server.registerTool(
  'search_inventory',
  {
    description:
      "Resolve a natural-language gear description ('void hand cannons in the vault', 'my hunter exotics') into a small ranked list of concrete items with their itemInstanceId. Call this before any write tool to get the exact item to act on. Returns only the matching items, by name — never the whole inventory.",
    inputSchema: {
      query: z.string().describe('Free-text gear description, e.g. "arc sniper" or "exotic warlock chest".'),
      characterId: z.string().optional().describe('Optional: scope to one character.'),
      location: z.enum(['vault', 'character', 'equipped', 'postmaster', 'any']).default('any'),
      limit: z.number().int().min(1).max(25).default(10),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, characterId, location, limit }) => {
    const inv = await getInventory();
    let items = inv.items.filter((i) => matchesText(i, query));
    if (location !== 'any') items = items.filter((i) => i.location.kind === location);
    if (characterId) items = items.filter((i) => 'characterId' in i.location && i.location.characterId === characterId);
    items.sort((a, b) => (b.powerLevel ?? 0) - (a.powerLevel ?? 0));
    const limited = items.slice(0, limit);
    return text(JSON.stringify({ matched: items.length, returned: limited.length, items: limited.map(summarize) }, null, 2));
  },
);

server.registerTool(
  'score_items',
  {
    description:
      "Grade weapons against the DIM community god-roll wishlist (the source Destiny Recipes uses), tagged for PvE or PvP. Use for 'is this a good roll?', 'what should I keep?', vault triage. Returns per-item tier (S/A/B/C/D/F or 'unrated'), matched-perk score, and the wishlist version so verdicts are grounded, not invented.",
    inputSchema: {
      itemInstanceIds: z.array(z.string()).describe('Weapons to score (from search_inventory).'),
      activity: z.enum(['pve', 'pvp', 'any']).default('any'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ itemInstanceIds, activity }) => {
    const inv = await getInventory();
    const results = [];
    for (const id of itemInstanceIds) {
      const item = inv.items.find((i) => i.itemInstanceId === id);
      if (!item) {
        results.push({ itemInstanceId: id, error: 'not found' });
        continue;
      }
      const s = await scoreRoll(item.itemHash, item.plugHashes, activity as RollTag);
      results.push({
        itemInstanceId: id,
        name: item.name,
        type: item.itemType,
        locked: item.locked,
        tier: s.tier,
        score: Number(s.score.toFixed(2)),
        matchedRolls: s.matchedRolls,
        hasWishlist: s.hasWishlist,
        wishlistVersion: s.wishlistVersion,
      });
    }
    return text(JSON.stringify({ results }, null, 2));
  },
);

// ─────────────────────────────── WRITE TOOLS ──────────────────────────────
// dry_run defaults to true: preview the plan, mutate nothing. The Skill tells
// the model to show the plan, get an explicit yes, then re-call dry_run=false.

const DRY_RUN = z
  .boolean()
  .default(true)
  .describe('When true (default), return the plan without mutating. Set false only after the user has explicitly confirmed.');

server.registerTool(
  'transfer_item',
  {
    description:
      'Move an item to the vault or a specific character. Char-to-char is not one call — it routes through the vault, so this may be multiple steps. dry_run=true previews the plan.',
    inputSchema: {
      itemInstanceId: z.string(),
      destination: z.string().describe("'vault' or a target characterId."),
      dry_run: DRY_RUN,
    },
    annotations: { destructiveHint: true },
  },
  async ({ itemInstanceId, destination, dry_run }) => {
    const item = await requireItem(itemInstanceId);
    const steps = planTransfer(item, destination);
    if (steps.length === 0) return text(`${item.name} is already at the requested destination — nothing to do.`);
    const plan = steps.map((s) => s.description);
    if (dry_run) return text(`PLAN (not executed) — move ${item.name}:\n- ${plan.join('\n- ')}`);
    const done = await executeTransfer(itemInstanceId, destination);
    return text(`Executed:\n- ${done.join('\n- ')}`);
  },
);

server.registerTool(
  'equip_item',
  {
    description:
      'Equip a single item on the character it currently sits on. Fails mid-activity. dry_run=true previews.',
    inputSchema: { itemInstanceId: z.string(), dry_run: DRY_RUN },
    annotations: { destructiveHint: true },
  },
  async ({ itemInstanceId, dry_run }) => {
    const item = await requireItem(itemInstanceId);
    const loc = item.location;
    if (loc.kind === 'vault') return text(`${item.name} is in the vault — transfer it to a character first.`);
    if (!('characterId' in loc)) return text(`Cannot determine which character holds ${item.name}.`);
    if (dry_run) return text(`PLAN (not executed): equip ${item.name} on character ${loc.characterId} (must not be mid-activity).`);
    await equipOne(item, loc.characterId);
    return text(`Equipped ${item.name}.`);
  },
);

server.registerTool(
  'set_lock',
  {
    description:
      "Lock or unlock an item. The vault-cleanup primitive: lock keepers, unlock rejects so the user can bulk-dismantle in-game. Reversible. This does NOT dismantle — the API has no delete endpoint; the user always does the final dismantle themselves. dry_run=true previews.",
    inputSchema: { itemInstanceId: z.string(), locked: z.boolean(), dry_run: DRY_RUN },
    annotations: { destructiveHint: true },
  },
  async ({ itemInstanceId, locked, dry_run }) => {
    const item = await requireItem(itemInstanceId);
    if (item.locked === locked) return text(`${item.name} is already ${locked ? 'locked' : 'unlocked'}.`);
    const inv = await getInventory();
    const loc = item.location;
    const characterId = 'characterId' in loc ? loc.characterId : inv.characters[0]?.characterId;
    if (!characterId) return text('No character available to perform the lock action.');
    const verb = locked ? 'Lock' : 'Unlock';
    if (dry_run) return text(`PLAN (not executed): ${verb} ${item.name}.`);
    await setLock(item, characterId, locked);
    return text(`${verb}ed ${item.name}.`);
  },
);

server.registerTool(
  'pull_postmaster',
  {
    description: 'Pull an item from the postmaster onto its character (needs a free slot). dry_run=true previews.',
    inputSchema: { itemInstanceId: z.string(), dry_run: DRY_RUN },
    annotations: { destructiveHint: true },
  },
  async ({ itemInstanceId, dry_run }) => {
    const item = await requireItem(itemInstanceId);
    if (item.location.kind !== 'postmaster') return text(`${item.name} is not in the postmaster.`);
    const characterId = item.location.characterId;
    if (dry_run) return text(`PLAN (not executed): pull ${item.name} from the postmaster onto character ${characterId}.`);
    await pullPostmaster(item, characterId);
    return text(`Pulled ${item.name} from the postmaster.`);
  },
);

// ─────────────────────────────── BOOT ─────────────────────────────────────

async function main() {
  // Warm the manifest so the first tool call is fast. Non-fatal on failure
  // (e.g. not yet authenticated) — the first real call will surface the error.
  await ensureManifest().catch(() => {});
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel — log only to stderr.
  console.error('[destiny-ghost] MCP server ready on stdio.');
}

main().catch((err) => {
  console.error('[destiny-ghost] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
