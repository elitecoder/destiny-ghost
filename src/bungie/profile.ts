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
  DestinyComponentType.ItemSockets, // 305 — the rolled perks we score
  DestinyComponentType.ItemCommonData, // 307 — lock state
];

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
