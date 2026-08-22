/**
 * Whole-vault health report — the bird's-eye view companion to the per-weapon
 * keeper-planner and per-archetype armor-planner.
 *
 * Farming never stops, so re-deriving "what's the biggest pile right now" by
 * hand every session doesn't scale. These functions take a flattened,
 * pure-data view of the account (no network, no manifest) so the report is
 * unit-testable; `src/bungie/vault-report-cli.ts` wires it to the live
 * inventory + DIM tags.
 */

import type { TagValue } from '../dimsync/client.js';

/** A junk-ish tag: "get rid of this", as opposed to keep/favorite. */
const JUNKY_TAGS = new Set<TagValue>(['infuse', 'junk', 'archive']);

/** A flattened, class/location-resolved view of one instanced item. */
export interface VaultItem {
  itemInstanceId: string;
  name: string;
  tierType: string;
  itemType: string;
  /** 0=Titan, 1=Hunter, 2=Warlock, 3=any. */
  classType: number;
  locked: boolean;
  location: 'vault' | 'character' | 'equipped' | 'postmaster';
  /** Armor's intrinsic perk (e.g. "Grenadier"). Undefined for weapons/old armor. */
  archetype?: string;
  tag?: TagValue;
}

const CLASS_NAMES = ['Titan', 'Hunter', 'Warlock'];
const ARMOR_SLOTS = new Set([
  'Helmet',
  'Gauntlets',
  'Chest Armor',
  'Leg Armor',
  'Class Armor',
  'Warlock Bond',
  'Hunter Cloak',
  'Titan Mark',
]);
const NON_WEAPON_TYPES = new Set(['Consumable', 'Modification', 'Vehicle', 'Ship', 'Ghost Shell', 'Emblem']);

function armorSlotOf(itemType: string): string | undefined {
  if (!ARMOR_SLOTS.has(itemType)) return undefined;
  return ['Warlock Bond', 'Hunter Cloak', 'Titan Mark'].includes(itemType) ? 'Class Armor' : itemType;
}

export interface WeaponDupeRow {
  name: string;
  total: number;
  untagged: number;
  locked: number;
}

/**
 * Legendary weapons grouped by name (not itemHash — reissues share a name),
 * sorted by total copy count descending. This is the "what's the biggest
 * pile right now" table — re-run any time, not just after a farming session.
 */
export function weaponDupeCounts(items: VaultItem[], minCopies = 5): WeaponDupeRow[] {
  const byName = new Map<string, WeaponDupeRow>();
  for (const it of items) {
    if (it.tierType !== 'Legendary') continue;
    if (armorSlotOf(it.itemType)) continue;
    if (NON_WEAPON_TYPES.has(it.itemType)) continue;
    const row = byName.get(it.name) ?? { name: it.name, total: 0, untagged: 0, locked: 0 };
    row.total++;
    if (!it.tag) row.untagged++;
    if (it.locked) row.locked++;
    byName.set(it.name, row);
  }
  return [...byName.values()]
    .filter((r) => r.total >= minCopies)
    .sort((a, b) => b.total - a.total);
}

export interface ArmorSlotRow {
  className: string;
  slot: string;
  total: number;
  untagged: number;
  infusePending: number;
  keep: number;
  locked: number;
}

/**
 * Legendary armor grouped by (class, slot) — the per-slot picture across all
 * three classes, not just whichever one you triaged last.
 */
export function armorByClassSlot(items: VaultItem[]): ArmorSlotRow[] {
  const byKey = new Map<string, ArmorSlotRow>();
  for (const it of items) {
    if (it.tierType !== 'Legendary') continue;
    const slot = armorSlotOf(it.itemType);
    if (!slot) continue;
    const className = CLASS_NAMES[it.classType] ?? 'Any';
    const key = `${className}::${slot}`;
    const row = byKey.get(key) ?? { className, slot, total: 0, untagged: 0, infusePending: 0, keep: 0, locked: 0 };
    row.total++;
    if (!it.tag) row.untagged++;
    else if (it.tag === 'infuse') row.infusePending++;
    else if (it.tag === 'keep') row.keep++;
    if (it.locked) row.locked++;
    byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) => b.total - a.total);
}

/**
 * Items tagged infuse/junk/archive while STILL locked — a live contradiction
 * (locked = protect, junky tag = get rid of). Never auto-resolve; surface for
 * the user to decide, same as any other locked-not-selected copy.
 */
export function lockTagContradictions(items: VaultItem[]): VaultItem[] {
  return items.filter((it) => it.locked && it.tag && JUNKY_TAGS.has(it.tag));
}

const SLOT_SUFFIXES = [
  'Helm', 'Helmet', 'Hood', 'Mask', 'Cage', 'Crown',
  'Gloves', 'Grips', 'Gauntlets', 'Handguards', 'Grasps',
  'Vest', 'Plate', 'Robes', 'Cover', 'Cloak', 'Wraps', 'Chest',
  'Boots', 'Greaves', 'Strides', 'Legs', 'Treads',
  'Bond', 'Mark', 'Mind',
];

function setPrefixOf(name: string): string | undefined {
  for (const suf of SLOT_SUFFIXES) {
    if (name.endsWith(' ' + suf)) return name.slice(0, -(suf.length + 1));
  }
  return undefined;
}

export interface NamedSetRisk {
  className: string;
  setName: string;
  slotsOwned: number;
  piecesOwned: number;
  /** Pieces tagged infuse/junk/archive that belong to this set — review before dismantling. */
  atRisk: VaultItem[];
}

/**
 * Armor pieces sharing a name prefix across 2+ slots (a candidate "named set",
 * e.g. "Thunderhead Boots" + "Thunderhead Bond") where at least one piece is
 * tagged junky. The per-tertiary/floor armor planner has no concept of set
 * bonuses, so a set-bonus piece can get wrongly flagged redundant — this is
 * the guardrail that catches it before dismantle.
 */
export function namedSetRisk(items: VaultItem[]): NamedSetRisk[] {
  const bySet = new Map<string, { className: string; setName: string; slots: Set<string>; items: VaultItem[] }>();
  for (const it of items) {
    if (it.tierType !== 'Legendary') continue;
    const slot = armorSlotOf(it.itemType);
    if (!slot) continue;
    const prefix = setPrefixOf(it.name);
    if (!prefix) continue;
    const className = CLASS_NAMES[it.classType] ?? 'Any';
    const key = `${className}::${prefix}`;
    const e = bySet.get(key) ?? { className, setName: prefix, slots: new Set<string>(), items: [] };
    e.slots.add(slot);
    e.items.push(it);
    bySet.set(key, e);
  }
  const out: NamedSetRisk[] = [];
  for (const e of bySet.values()) {
    if (e.slots.size < 2) continue;
    const atRisk = e.items.filter((it) => it.tag && JUNKY_TAGS.has(it.tag));
    if (!atRisk.length) continue;
    out.push({ className: e.className, setName: e.setName, slotsOwned: e.slots.size, piecesOwned: e.items.length, atRisk });
  }
  return out.sort((a, b) => b.piecesOwned - a.piecesOwned);
}

/** Instanced item counts by tier, for the top-level account snapshot. */
export function tierBreakdown(items: VaultItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) out[it.tierType] = (out[it.tierType] ?? 0) + 1;
  return out;
}
