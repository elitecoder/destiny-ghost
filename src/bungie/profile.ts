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
 * The six armor stats, in canonical display order. These stat hashes are
 * game-stable (verified against Mijago/D2ArmorPicker's ArmorStatHashes AND
 * Bungie's own DestinyStatDefinition manifest). Armor 3.0 (Edge of Fate)
 * RENAMED the stats — same hashes, new display names — so we use the current
 * in-game names. Legacy names in parentheses for reference:
 *   2996146975  Weapons   (was Mobility)
 *   392767087   Health    (was Resilience)
 *   1943323491  Class     (was Recovery)  — note: NOT the legacy 1943323000
 *   1735777505  Grenade   (was Discipline)
 *   144602215   Super     (was Intellect)
 *   4244567218  Melee     (was Strength)
 */
export type StatName = 'Weapons' | 'Health' | 'Class' | 'Grenade' | 'Super' | 'Melee';
export const STAT_ORDER: StatName[] = ['Weapons', 'Health', 'Class', 'Grenade', 'Super', 'Melee'];
export type ArmorStats = Record<StatName, number>;
const ARMOR_STAT_HASH_TO_NAME: Record<number, StatName> = {
  2996146975: 'Weapons',
  392767087: 'Health',
  1943323491: 'Class',
  1735777505: 'Grenade',
  144602215: 'Super',
  4244567218: 'Melee',
};

/**
 * Read the six armor stats from the ItemStats (304) component. These are the
 * per-stat values Bungie reports for the piece — base roll + current upgrade
 * (masterwork) level + any socketed stat mods (i.e. exactly what the player
 * sees in DIM/in-game). The loadout solver derives the piece's own stats
 * (base + upgrade, mods removed) by subtracting socketed stat-mod bonuses, so
 * it can re-plan mods within the energy budget; this field is for display and
 * quick reasoning. Returns undefined for non-armor (weapons have no armor-stat
 * entries).
 */
export function armorStatsFromComponent(comp: { stats?: Record<number, { statHash: number; value: number }> } | undefined): ArmorStats | undefined {
  if (!comp?.stats) return undefined;
  const out = { Weapons: 0, Health: 0, Class: 0, Grenade: 0, Super: 0, Melee: 0 } as ArmorStats;
  let found = false;
  for (const [key, stat] of Object.entries(comp.stats)) {
    const name = ARMOR_STAT_HASH_TO_NAME[Number(key)];
    if (name) {
      out[name] = stat.value;
      found = true;
    }
  }
  return found ? out : undefined;
}

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
  /** Class restriction from the item def: 0=Titan, 1=Hunter, 2=Warlock, 3=Any. */
  classType: number;
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
  /**
   * The six armor stats (Mobility/Resilience/Recovery/Discipline/Intellect/
   * Strength), as reported by the ItemStats component — base roll + current
   * masterwork + socketed stat mods. Undefined for non-armor. The loadout
   * solver re-derives clean base stats from stat plugs when re-planning mods.
   */
  stats?: ArmorStats;
  /** Armor energy capacity (the mod budget). Armor 2.0 caps at 10; Armor 3.0 tier-5 reports 11. Undefined for non-armor. */
  energyCapacity?: number;
  /** Armor 3.0 gear tier (1–5), present only on Armor 3.0 pieces. Undefined for Armor 2.0 / non-armor. */
  gearTier?: number;
  /**
   * True when the item has a Masterwork plug inserted (DestinyItemState bit 4).
   * For exotic weapons this means the catalyst is completed & applied.
   */
  masterworked?: boolean;
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

/**
 * Optimistically patch one item's lock state in the cached snapshot after a
 * confirmed successful lock write. Bungie's GetProfile lags a few seconds
 * behind a write, so a forced refetch right after locking can still return the
 * OLD state and then cache it for the full TTL — the source of "locked: false"
 * lies right after a successful lock. We know exactly what changed, so we apply
 * it locally instead of trusting a laggy refetch. No-op if nothing is cached.
 */
export function patchLockState(itemInstanceId: string, locked: boolean): void {
  if (!snapshot) return;
  applyLockPatch(snapshot, itemInstanceId, locked);
}

/**
 * Pure snapshot mutation: set one item's lock state in place. Returns true if
 * the item was found and patched. Extracted so it's unit-testable without the
 * module-level cache or any network.
 */
export function applyLockPatch(inv: GhostInventory, itemInstanceId: string, locked: boolean): boolean {
  const item = inv.items.find((i) => i.itemInstanceId === itemInstanceId);
  if (!item) return false;
  item.locked = locked;
  return true;
}

function flatten(res: DestinyProfileResponse, membership: DestinyMembership): GhostInventory {
  const instances = res.itemComponents?.instances?.data ?? {};
  const sockets = res.itemComponents?.sockets?.data ?? {};
  const reusablePlugs = res.itemComponents?.reusablePlugs?.data ?? {};
  const statsData = res.itemComponents?.stats?.data ?? {};

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
    const energyCapacity = instance?.energy?.energyCapacity;
    items.push({
      itemInstanceId: raw.itemInstanceId,
      itemHash: raw.itemHash,
      name: def.displayProperties?.name ?? `Item ${raw.itemHash}`,
      itemType: def.itemTypeDisplayName ?? 'Unknown',
      classType: def.classType ?? 3,
      tierType: def.inventory?.tierTypeName ?? 'Unknown',
      slot: bucketDef(def.inventory?.bucketTypeHash ?? 0)?.displayProperties?.name,
      element: damageHash ? damageTypeDef(damageHash)?.displayProperties?.name : undefined,
      powerLevel: instance?.primaryStat?.value,
      // state is a bitflag: 1 = locked, 4 = masterwork plug inserted (exotic catalyst done).
      locked: ((raw.state ?? 0) & 1) === 1,
      masterworked: ((raw.state ?? 0) & 4) === 4,
      equipped,
      location,
      plugHashes,
      perkColumns: buildPerkColumns(raw),
      stats: armorStatsFromComponent(raw.itemInstanceId ? statsData[raw.itemInstanceId] : undefined),
      energyCapacity,
      gearTier: (instance as any)?.gearTier,
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
