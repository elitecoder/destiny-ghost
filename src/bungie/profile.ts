import {
  DestinyComponentType,
  getLinkedProfiles,
  getProfile,
  type DestinyProfileResponse,
} from 'bungie-api-ts/destiny2';
import { getMembershipDataForCurrentUser } from 'bungie-api-ts/user';
import { authedHttp } from './client.js';
import { readTokens } from './tokens.js';
import {
  bucketDef,
  classDef,
  damageTypeDef,
  ensureManifest,
  itemDef,
  itemName,
} from './manifest.js';

/** The components we need to reason about inventory, equipment, and rolls. */
const COMPONENTS = [
  DestinyComponentType.Profiles,
  DestinyComponentType.ProfileInventories, // 102 — the vault
  DestinyComponentType.Characters,
  DestinyComponentType.CharacterInventories, // 201
  DestinyComponentType.CharacterEquipment, // 205
  DestinyComponentType.ItemInstances, // 300 — power, quality
  DestinyComponentType.ItemPerks, // 302
  DestinyComponentType.ItemStats, // 304
  DestinyComponentType.ItemSockets, // 305 — the currently-selected rolled perks
  DestinyComponentType.ItemReusablePlugs, // 310 — ALL selectable options per socket
  DestinyComponentType.ItemCommonData, // 307 — lock state
];

/** Bungie's "WEAPON PERKS" socket category — the barrel/mag/trait/origin columns. */
const WEAPON_PERKS_CATEGORY = 4241085061;

/**
 * One perk column on a weapon: the currently-selected plug plus EVERY plug this
 * specific copy can switch to in that column. On gear-tier weapons a trait
 * column commonly has 2–3 selectable perks, so a single copy covers multiple
 * rolls — dedup MUST reason over `options`, never `selected` alone.
 */
export interface PerkColumn {
  selected?: string;
  options: string[];
}

/**
 * The load-bearing dedup primitive, kept pure so it's unit-testable without the
 * manifest or network. For each weapon-perk socket index, emit the column's
 * FULL selectable options (from ItemReusablePlugs), falling back to the single
 * selected plug only when a column reports no reusable list (a fixed perk).
 *
 * The bug this guards against: reading `selected` alone treats a copy as one
 * fixed roll, when a gear-tier trait column usually offers 2–3 swappable perks.
 *
 * @param perkIndexes socket indexes that are weapon-perk columns (barrel/mag/trait/origin)
 * @param selectedByIndex the currently-selected plug hash per socket index
 * @param optionsByIndex all reusable plug hashes per socket index
 * @param resolveName hash → display name
 */
export function columnsFromSockets(
  perkIndexes: number[],
  selectedByIndex: Record<number, number | undefined>,
  optionsByIndex: Record<number, number[]>,
  resolveName: (hash: number) => string,
): PerkColumn[] {
  const columns: PerkColumn[] = [];
  for (const idx of perkIndexes) {
    const selectedHash = selectedByIndex[idx];
    const optionHashes = optionsByIndex[idx] ?? [];
    const hashes = optionHashes.length ? optionHashes : selectedHash ? [selectedHash] : [];
    if (!hashes.length) continue;
    columns.push({
      selected: selectedHash ? resolveName(selectedHash) : undefined,
      options: hashes.map(resolveName),
    });
  }
  return columns;
}

export interface DestinyMembership {
  membershipType: number;
  membershipId: string;
  displayName: string;
}

/** Resolve the logged-in user's primary Destiny profile (platform + id). */
export async function resolveMembership(): Promise<DestinyMembership> {
  const user = (await getMembershipDataForCurrentUser(authedHttp)).Response;
  const memberships = user.destinyMemberships;
  if (!memberships?.length) throw new Error('No Destiny profiles on this Bungie account.');
  const primaryId = user.primaryMembershipId;
  const chosen =
    memberships.find((m) => m.membershipId === primaryId) ??
    // Prefer a cross-save primary; else the first non-overridden platform.
    memberships.find((m) => !m.crossSaveOverride || m.crossSaveOverride === m.membershipType) ??
    memberships[0];
  return {
    membershipType: chosen.membershipType,
    membershipId: chosen.membershipId,
    displayName: chosen.displayName ?? chosen.bungieGlobalDisplayName ?? 'Guardian',
  };
}

export type ItemLocation =
  | { kind: 'vault' }
  | { kind: 'character'; characterId: string }
  | { kind: 'equipped'; characterId: string }
  | { kind: 'postmaster'; characterId: string };

export interface GhostItem {
  itemInstanceId?: string;
  itemHash: number;
  name: string;
  itemType: string; // e.g. "Hand Cannon", "Helmet"
  tierType: string; // "Legendary" | "Exotic" | ...
  slot?: string; // bucket display name
  element?: string; // damage type name
  powerLevel?: number;
  locked: boolean;
  equipped: boolean;
  location: ItemLocation;
  /** Currently-rolled perk hashes (from sockets) — used for roll scoring. */
  plugHashes: number[];
  /**
   * The weapon's perk columns (barrel/mag/trait1/trait2/origin, in socket
   * order), each with its full set of selectable options. Empty for
   * non-weapons or items with no socket data. This is the anti-footgun for
   * dedup: it exposes every perk a copy can roll to, not just the equipped one.
   */
  perkColumns: PerkColumn[];
}

export interface GhostCharacter {
  characterId: string;
  classType: number;
  className: string;
  light: number;
}

export interface GhostInventory {
  membership: DestinyMembership;
  characters: GhostCharacter[];
  items: GhostItem[];
  /** Fetched-at epoch ms — the caller decides how stale is too stale. */
  fetchedAt: number;
}

let snapshot: GhostInventory | null = null;

/**
 * Fetch and flatten the full account inventory. Cached in-process for `ttlMs`;
 * pass `force` to bypass (used before/after writes so we act on fresh state).
 */
export async function getInventory(opts: { force?: boolean; ttlMs?: number } = {}): Promise<GhostInventory> {
  const ttl = opts.ttlMs ?? 30_000;
  if (!opts.force && snapshot && Date.now() - snapshot.fetchedAt < ttl) return snapshot;

  await ensureManifest();
  const membership = await resolveMembership();
  const res = (
    await getProfile(authedHttp, {
      destinyMembershipId: membership.membershipId,
      membershipType: membership.membershipType,
      components: COMPONENTS,
    })
  ).Response;

  snapshot = flatten(res, membership);
  return snapshot;
}

/** Invalidate the cached snapshot (call after a successful write). */
export function invalidateInventory(): void {
  snapshot = null;
}

function flatten(res: DestinyProfileResponse, membership: DestinyMembership): GhostInventory {
  const instances = res.itemComponents?.instances?.data ?? {};
  const sockets = res.itemComponents?.sockets?.data ?? {};
  const reusablePlugs = res.itemComponents?.reusablePlugs?.data ?? {};

  /**
   * Build the per-column perk view for one instanced weapon. Uses the item
   * def's socket categories to pick only the WEAPON PERKS sockets (skips
   * cosmetics/masterwork/mods), and reads every selectable plug per column from
   * the ItemReusablePlugs component — falling back to the single selected plug
   * when a column has no reusable list (fixed perks).
   */
  const buildPerkColumns = (raw: any): PerkColumn[] => {
    if (!raw.itemInstanceId) return [];
    const def = itemDef(raw.itemHash);
    const socketList = sockets[raw.itemInstanceId]?.sockets ?? [];
    const reusable = (reusablePlugs[raw.itemInstanceId]?.plugs ?? {}) as Record<
      number,
      Array<{ plugItemHash: number }>
    >;
    const categories = def?.sockets?.socketCategories ?? [];
    const perkCat = categories.find((c: any) => c.socketCategoryHash === WEAPON_PERKS_CATEGORY);
    // Fall back to all sockets if the def has no weapon-perks category (rare).
    const indexes: number[] = perkCat?.socketIndexes ?? socketList.map((_: unknown, i: number) => i);

    const selectedByIndex: Record<number, number | undefined> = {};
    const optionsByIndex: Record<number, number[]> = {};
    for (const idx of indexes) {
      selectedByIndex[idx] = socketList[idx]?.plugHash;
      optionsByIndex[idx] = reusable[idx]?.map((p) => p.plugItemHash) ?? [];
    }
    return columnsFromSockets(indexes, selectedByIndex, optionsByIndex, itemName);
  };

  const characters: GhostCharacter[] = Object.values(res.characters?.data ?? {}).map((c) => ({
    characterId: c.characterId,
    classType: c.classType,
    className: classDef(c.classHash ?? 0)?.displayProperties?.name ?? classNameFor(c.classType),
    light: c.light,
  }));

  const items: GhostItem[] = [];

  const pushItem = (raw: any, location: ItemLocation, equipped: boolean) => {
    const def = itemDef(raw.itemHash);
    if (!def) return;
    const instance = raw.itemInstanceId ? instances[raw.itemInstanceId] : undefined;
    const socketList = raw.itemInstanceId ? sockets[raw.itemInstanceId]?.sockets ?? [] : [];
    const plugHashes = socketList
      .filter((s: any) => s.isEnabled && s.plugHash)
      .map((s: any) => s.plugHash as number);
    const damageHash = instance?.damageTypeHash;
    items.push({
      itemInstanceId: raw.itemInstanceId,
      itemHash: raw.itemHash,
      name: def.displayProperties?.name ?? `Item ${raw.itemHash}`,
      itemType: def.itemTypeDisplayName ?? 'Unknown',
      tierType: def.inventory?.tierTypeName ?? 'Unknown',
      slot: bucketDef(def.inventory?.bucketTypeHash ?? 0)?.displayProperties?.name,
      element: damageHash ? damageTypeDef(damageHash)?.displayProperties?.name : undefined,
      powerLevel: instance?.primaryStat?.value,
      // state is a bitflag: 1 = locked.
      locked: ((raw.state ?? 0) & 1) === 1,
      equipped,
      location,
      plugHashes,
      perkColumns: buildPerkColumns(raw),
    });
  };

  // Vault (profile inventory).
  for (const raw of res.profileInventory?.data?.items ?? []) {
    pushItem(raw, { kind: 'vault' }, false);
  }

  // Per-character inventory + equipment.
  const charInv = res.characterInventories?.data ?? {};
  const charEquip = res.characterEquipment?.data ?? {};
  const POSTMASTER_BUCKET = 215593132;
  for (const characterId of Object.keys(res.characters?.data ?? {})) {
    for (const raw of charInv[characterId]?.items ?? []) {
      const inPostmaster = raw.bucketHash === POSTMASTER_BUCKET;
      pushItem(
        raw,
        inPostmaster ? { kind: 'postmaster', characterId } : { kind: 'character', characterId },
        false,
      );
    }
    for (const raw of charEquip[characterId]?.items ?? []) {
      pushItem(raw, { kind: 'equipped', characterId }, true);
    }
  }

  return { membership, characters, items, fetchedAt: Date.now() };
}

function classNameFor(classType: number): string {
  return ['Titan', 'Hunter', 'Warlock'][classType] ?? 'Guardian';
}

/** Re-export so callers can force a linked-profile refresh if cross-save changes. */
export { getLinkedProfiles };
