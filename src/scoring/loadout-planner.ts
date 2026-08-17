/**
 * Armor 3.0 loadout feasibility oracle.
 *
 * Given target stat minimums, an exotic constraint, and fragment stat deltas,
 * searches the player's armor (all slots, vault + inventory + equipped) for a
 * 5-piece set that can hit the targets with stat mods. Answers the question:
 *   "Can I already build this from armor I own, or do I need to farm?"
 *
 * Armor 3.0 economics (Edge of Fate), verified against Mijago/D2ArmorPicker:
 *   - Stats were RENAMED (same hashes): Weapons / Health / Class / Grenade /
 *     Super / Melee. See profile.ts for the hash→name table.
 *   - Each piece's contribution = its ItemStats values (base roll + actual
 *     upgrade/masterwork level) minus any socketed stat mods (so mods can be
 *     re-planned). We HONOR the actual upgrade state — we do not assume MW.
 *   - Stat mods: minor +5 (1 energy), major +10 (3 energy). Artifice (+3, 0
 *     energy) is deliberately excluded per operator direction (tier-5 armor is
 *     preferred over artifice slots).
 *   - Energy budget per piece = its actual energyCapacity (tier-5 = 11).
 *   - Stat mods: ONE per piece (a minor +5 needing ≥1 energy, or a major +10
 *     needing ≥3 energy). A 5-piece set therefore has at most 5 stat mods total
 *     (max +50 to a single stat, or split across stats) — NOT a shared energy
 *     pool with unlimited mods per piece. (An earlier version wrongly assumed a
 *     shared pool and over-promised; the player corrected this from in-game.)
 *
 * The solver is pure (no network/manifest) so it is unit-testable. The MCP tool
 * layer builds LoadoutPiece[] from the live inventory and calls `solveLoadout`.
 */

import { STAT_ORDER, type StatName, type ArmorStats } from '../bungie/profile.js';

export const SLOTS = ['Helmet', 'Gauntlets', 'Chest Armor', 'Leg Armor', 'Class Item'] as const;
export type Slot = (typeof SLOTS)[number];

/**
 * Map a Bungie `itemTypeDisplayName` to a canonical armor slot. Class items are
 * class-specific ("Warlock Bond" / "Hunter Cloak" / "Titan Mark"), not "Class
 * Item", so they must be aliased or they'd be excluded from the 5-slot search.
 */
const SLOT_ALIASES: Record<string, Slot> = {
  Helmet: 'Helmet',
  Gauntlets: 'Gauntlets',
  'Chest Armor': 'Chest Armor',
  'Leg Armor': 'Leg Armor',
  'Warlock Bond': 'Class Item',
  'Hunter Cloak': 'Class Item',
  'Titan Mark': 'Class Item',
};
export function slotOf(itemType: string): Slot | undefined {
  return SLOT_ALIASES[itemType];
}

/**
 * Stat-mod plug hashes (Armor 3.0), from D2ArmorPicker's STAT_MOD_VALUES.
 * Used (a) to strip socketed stat mods from ItemStats when deriving a piece's
 * own stats, and (b) as the mod catalogue the solver allocates. Artifice mods
 * are intentionally absent.
 */
const STAT_MOD_BY_HASH: Record<number, { stat: StatName; bonus: number; cost: number; kind: 'minor' | 'major' }> = {
  // minor (+5, 1 energy)
  1703647492: { stat: 'Weapons', bonus: 5, cost: 1, kind: 'minor' },
  2532323436: { stat: 'Health', bonus: 5, cost: 1, kind: 'minor' },
  1237786518: { stat: 'Class', bonus: 5, cost: 1, kind: 'minor' },
  4021790309: { stat: 'Grenade', bonus: 5, cost: 1, kind: 'minor' },
  350061697: { stat: 'Super', bonus: 5, cost: 1, kind: 'minor' },
  2639422088: { stat: 'Melee', bonus: 5, cost: 1, kind: 'minor' },
  // major (+10, 3 energy)
  4183296050: { stat: 'Weapons', bonus: 10, cost: 3, kind: 'major' },
  1180408010: { stat: 'Health', bonus: 10, cost: 3, kind: 'major' },
  4204488676: { stat: 'Class', bonus: 10, cost: 3, kind: 'major' },
  1435557120: { stat: 'Grenade', bonus: 10, cost: 3, kind: 'major' },
  2724608735: { stat: 'Super', bonus: 10, cost: 3, kind: 'major' },
  4287799666: { stat: 'Melee', bonus: 10, cost: 3, kind: 'major' },
};

/** Minor/major mod definitions indexed by stat, for allocation. */
const MODS_BY_STAT: Record<StatName, { minor: typeof STAT_MOD_BY_HASH[number]; major: typeof STAT_MOD_BY_HASH[number] }> = {
  Weapons: { minor: STAT_MOD_BY_HASH[1703647492], major: STAT_MOD_BY_HASH[4183296050] },
  Health: { minor: STAT_MOD_BY_HASH[2532323436], major: STAT_MOD_BY_HASH[1180408010] },
  Class: { minor: STAT_MOD_BY_HASH[1237786518], major: STAT_MOD_BY_HASH[4204488676] },
  Grenade: { minor: STAT_MOD_BY_HASH[4021790309], major: STAT_MOD_BY_HASH[1435557120] },
  Super: { minor: STAT_MOD_BY_HASH[350061697], major: STAT_MOD_BY_HASH[2724608735] },
  Melee: { minor: STAT_MOD_BY_HASH[2639422088], major: STAT_MOD_BY_HASH[4287799666] },
};

/**
 * Max bonus ONE stat can receive from stat mods: each of the 5 pieces holds at
 * most one major (+10), so devoting every piece's stat-mod slot to one stat
 * yields up to +50. (Armor 3.0 — one stat mod per piece, not a shared pool.)
 */
const MAX_MOD_BONUS_PER_STAT = 5 * 10;

/**
 * Armor 3.0 archetypes and their primary/secondary stats (Edge of Fate).
 * Source: Dot Esports armor-archetypes reference. The tertiary stat is random
 * per drop, so for farming we point the operator at archetypes whose primary or
 * secondary covers the bottleneck stat, with a tertiary in the next-needed stat.
 */
export const ARCHETYPE_STATS: Record<string, { primary: StatName; secondary: StatName }> = {
  Siegebreaker: { primary: 'Health', secondary: 'Grenade' },
  Bulwark: { primary: 'Health', secondary: 'Class' },
  Brawler: { primary: 'Melee', secondary: 'Health' },
  Skirmisher: { primary: 'Melee', secondary: 'Weapons' },
  Grenadier: { primary: 'Grenade', secondary: 'Super' },
  Demolitionist: { primary: 'Grenade', secondary: 'Class' },
  Colossus: { primary: 'Super', secondary: 'Health' },
  Paragon: { primary: 'Super', secondary: 'Melee' },
  Reaver: { primary: 'Class', secondary: 'Melee' },
  Specialist: { primary: 'Class', secondary: 'Weapons' },
  Gunner: { primary: 'Weapons', secondary: 'Grenade' },
  Powerhouse: { primary: 'Weapons', secondary: 'Super' },
};

export interface LoadoutPiece {
  itemInstanceId: string;
  name: string;
  slot: Slot;
  isExotic: boolean;
  /** 0=Titan, 1=Hunter, 2=Warlock, 3=any. */
  classType: number;
  /** ItemStats values (base + upgrade + socketed mods). */
  stats: ArmorStats;
  /** Armor energy capacity (the mod budget). Tier-5 = 11. */
  energyCapacity: number;
  /** Socketed plug hashes — used to strip stat mods for the piece's own stats. */
  plugHashes: number[];
  gearTier?: number;
}

export interface SetConstraint {
  /** A substring matched against each piece's name (e.g. "Smoke Jumper"). */
  name: string;
  /** Minimum number of pieces in the 5-set whose name contains `name`. */
  minCount: number;
}

export interface LoadoutTarget {
  /** 0=Titan, 1=Hunter, 2=Warlock. */
  classType: number;
  /** Minimum desired per stat. Omitted/0 = don't care. */
  target: Partial<ArmorStats>;
  /** Exotic constraint: a specific exotic name (case-insensitive), 'any', or 'none'. */
  exotic: string | 'any' | 'none';
  /** Fragment stat deltas, e.g. { Health: +10, Weapons: -5 }. */
  fragments?: Partial<ArmorStats>;
  /**
   * Named-set count constraints, e.g. require 2 pieces named "Smoke Jumper" and
   * 2 named "Thunderhead" (for 2-piece set bonuses). A piece matches a
   * constraint if its name contains the constraint's `name` substring.
   */
  setConstraints?: SetConstraint[];
}

export interface ModAllocation {
  stat: StatName;
  minors: number;
  majors: number;
  bonus: number;
  energy: number;
}

export interface SetPiece {
  name: string;
  itemInstanceId: string;
  slot: Slot;
  isExotic: boolean;
  stats: ArmorStats;
  energyCapacity: number;
  gearTier?: number;
}

export interface FeasibleSet {
  pieces: SetPiece[];
  baseStats: ArmorStats;
  finalStats: ArmorStats;
  mods: ModAllocation[];
  energyUsed: number;
  energyAvailable: number;
  waste: Partial<ArmorStats>;
}

export interface FarmGuidance {
  bottleneckStat: StatName;
  bottleneckSlot: Slot;
  shortfall: number;
  suggestedArchetypes: string[];
  message: string;
}

export interface ClosestSet {
  pieces: SetPiece[];
  finalStats: ArmorStats;
  shortfallByStat: Partial<ArmorStats>;
  totalShortfall: number;
}

export interface LoadoutResult {
  feasible: boolean;
  sets: FeasibleSet[];
  closest?: ClosestSet;
  guidance?: FarmGuidance;
  truncated?: boolean;
}

// ───────────────────────────── helpers ─────────────────────────────

function zeroStats(): ArmorStats {
  return { Weapons: 0, Health: 0, Class: 0, Grenade: 0, Super: 0, Melee: 0 };
}

/** A piece's own stats = ItemStats minus any socketed stat mods (mods get re-planned). */
export function ownStatsOf(p: LoadoutPiece): ArmorStats {
  const out: ArmorStats = { ...p.stats };
  for (const h of p.plugHashes) {
    const m = STAT_MOD_BY_HASH[h];
    if (m) out[m.stat] = Math.max(0, out[m.stat] - m.bonus);
  }
  return out;
}

/**
 * Armor 3.0 stat-mod model (CORRECTED): each armor piece holds AT MOST ONE
 * stat mod — a minor (+5, needs ≥1 energy) or a major (+10, needs ≥3 energy).
 * So a 5-piece set has at most 5 stat mods total, not an unlimited shared pool.
 * This is the max bonus a single piece can contribute to a stat via its one slot.
 */
export function maxModBonusOf(energyCapacity: number): number {
  if (energyCapacity >= 3) return 10; // a major fits
  if (energyCapacity >= 1) return 5; // only a minor fits
  return 0;
}

/**
 * Can `bonuses` (one max-mod-bonus per piece, i.e. 5 values) cover every stat's
 * `deficit`? Each bonus is one piece's single stat-mod slot, assignable to any
 * stat. Greedy: assign the largest available mods to the largest deficits first
 * (optimal for coverage — a mod fully burns down one deficit, no benefit to
 * splitting). Returns true iff all deficits reach zero within the 5 mods.
 */
export function modsCanFill(deficits: ArmorStats, bonuses: number[]): boolean {
  const defs = STAT_ORDER.map((s) => deficits[s])
    .filter((d) => d > 0)
    .sort((a, b) => b - a);
  const mods = [...bonuses].filter((b) => b > 0).sort((a, b) => b - a);
  let mi = 0;
  for (const d of defs) {
    let need = d;
    while (need > 0 && mi < mods.length) {
      need -= mods[mi];
      mi++;
    }
    if (need > 0) return false; // ran out of mod slots before covering this deficit
  }
  return true;
}

/**
 * Build the per-stat mod allocation plan for a feasible set (for display).
 * Assigns the 5 piece bonuses (largest first) to the largest deficits first,
 * recording minors vs majors per piece based on its energy capacity.
 */
function allocateMods(deficits: ArmorStats, pieces: { energyCapacity: number }[]): ModAllocation[] {
  // Work with (stat, deficit) pairs and (bonus, pieceIndex) pairs.
  const defPairs = STAT_ORDER.map((s) => ({ stat: s, d: deficits[s] }))
    .filter((x) => x.d > 0)
    .sort((a, b) => b.d - a.d);
  const modPairs = pieces
    .map((p, i) => ({ bonus: maxModBonusOf(p.energyCapacity), isMajor: p.energyCapacity >= 3, idx: i }))
    .filter((m) => m.bonus > 0)
    .sort((a, b) => b.bonus - a.bonus);
  const byStat: Record<string, { minors: number; majors: number; bonus: number }> = {};
  let mi = 0;
  for (const { stat, d } of defPairs) {
    let need = d;
    while (need > 0 && mi < modPairs.length) {
      const m = modPairs[mi++];
      byStat[stat] ??= { minors: 0, majors: 0, bonus: 0 };
      byStat[stat].bonus += m.bonus;
      if (m.isMajor) byStat[stat].majors++;
      else byStat[stat].minors++;
      need -= m.bonus;
    }
  }
  return STAT_ORDER.filter((s) => byStat[s]).map((s) => {
    const e = byStat[s];
    return { stat: s, minors: e.minors, majors: e.majors, bonus: e.bonus, energy: e.minors * 1 + e.majors * 3 };
  });
}

// ───────────────────────────── search ─────────────────────────────

const MAX_CANDIDATES_PER_SLOT = 50;
const MAX_NODES = 2_000_000;
const MAX_FEASIBLE_RESULTS = 5;

/** A candidate with its own-stats (ItemStats minus socketed mods) precomputed once. */
interface Cand {
  p: LoadoutPiece;
  own: ArmorStats;
  /** Which set-constraint names this piece satisfies (by name substring). */
  sets: string[];
}

/** Which of the `setNames` a piece satisfies (its name contains the substring). */
function setsOf(p: LoadoutPiece, setNames: string[]): string[] {
  return setNames.filter((n) => p.name.includes(n));
}

/** Dedup candidates by (ownStats vector + energy), keeping the first representative. */
function dedupByStatVector(pieces: LoadoutPiece[], setNames: string[]): Cand[] {
  const seen = new Map<string, Cand>();
  for (const p of pieces) {
    const own = ownStatsOf(p);
    const key = STAT_ORDER.map((s) => own[s]).join(',') + '|' + p.energyCapacity;
    if (!seen.has(key)) seen.set(key, { p, own, sets: setsOf(p, setNames) });
  }
  return [...seen.values()];
}

/** Sort candidates by relevance to the target (sum of own stats that the target cares about, desc). */
function sortByRelevance(cands: Cand[], target: Partial<ArmorStats>): Cand[] {
  const targetStats = STAT_ORDER.filter((s) => (target[s] ?? 0) > 0);
  return cands
    .map((c) => ({ c, score: targetStats.reduce((acc, s) => acc + c.own[s], 0) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c);
}

interface SlotProfile {
  candidates: Cand[];
  maxOwn: ArmorStats; // max ownStats[stat] among candidates
  maxEnergy: number; // max energyCapacity among candidates
}

function buildSlotProfile(cands: Cand[]): SlotProfile {
  const maxOwn = zeroStats();
  let maxEnergy = 0;
  for (const { p, own } of cands) {
    for (const s of STAT_ORDER) if (own[s] > maxOwn[s]) maxOwn[s] = own[s];
    if (p.energyCapacity > maxEnergy) maxEnergy = p.energyCapacity;
  }
  return { candidates: cands, maxOwn, maxEnergy };
}

function solveVariant(
  profiles: SlotProfile[],
  target: Partial<ArmorStats>,
  fragments: Partial<ArmorStats>,
  setConstraints: SetConstraint[],
): { feasible: FeasibleSet[]; closest: ClosestSet | null; truncated: boolean } {
  const feasible: FeasibleSet[] = [];
  let closest: ClosestSet | null = null;
  let truncated = false;
  let nodes = 0;

  const tgt = STAT_ORDER.map((s) => target[s] ?? 0);
  const frag = STAT_ORDER.map((s) => fragments[s] ?? 0);

  // Precompute, per level, how many of the remaining slots (level..end) contain
  // at least one candidate matching each set-constraint name — used to bound
  // the still-achievable set-member count and prune unsatisfiable branches.
  const setNames = setConstraints.map((c) => c.name);
  const remainingSetSlots: number[][] = []; // [level][constraintIdx] = count of slots with a member
  for (let i = 0; i < profiles.length; i++) {
    const counts = setConstraints.map(() => 0);
    for (let j = i; j < profiles.length; j++) {
      const cands = profiles[j].candidates;
      for (let ci = 0; ci < setConstraints.length; ci++) {
        if (cands.some((c) => c.sets.includes(setNames[ci]))) counts[ci]++;
      }
    }
    remainingSetSlots.push(counts);
  }

  // remainingMaxOwn[level][statIndex] and remainingMaxEnergy[level] (inclusive
  // from level). These are the SUM of per-slot maxes across the remaining slots
  // — a valid upper bound on what the remaining slots can contribute together.
  // (Taking the max-of-maxes instead would under-count stats that must come
  // from several slots and false-prune feasible branches — the Grenade-200 bug.)
  const remainingMaxOwn: number[][] = [];
  for (let i = 0; i < profiles.length; i++) {
    const mo = zeroStats();
    for (let j = i; j < profiles.length; j++) {
      for (const s of STAT_ORDER) mo[s] += profiles[j].maxOwn[s];
    }
    remainingMaxOwn.push(STAT_ORDER.map((s) => mo[s]));
  }

  // Max stat-mod bonus any ONE stat can receive across the full 5-piece set:
  // the sum of each slot's best possible single stat mod (major +10 when the
  // slot has a piece with ≥3 energy). Loose per-stat cap for the bound.
  const totalMaxModBonus = profiles.reduce((a, prof) => a + maxModBonusOf(prof.maxEnergy), 0);

  const chosen: Cand[] = [];
  const sums = zeroStats(); // own-stats sum
  let energySum = 0;
  const setCounts = setConstraints.map(() => 0); // per-constraint count so far

  /** Are all set-count constraints satisfied by the current `chosen` set? */
  function setConstraintsMet(): boolean {
    for (let ci = 0; ci < setConstraints.length; ci++) {
      if (setCounts[ci] < setConstraints[ci].minCount) return false;
    }
    return true;
  }

  function updateClosest(finalStats: ArmorStats) {
    const shortfallByStat: Partial<ArmorStats> = {};
    let total = 0;
    for (let i = 0; i < STAT_ORDER.length; i++) {
      const s = STAT_ORDER[i];
      const short = Math.max(0, tgt[i] - finalStats[s]);
      if (short > 0) {
        shortfallByStat[s] = short;
        total += short;
      }
    }
    if (!closest || total < closest.totalShortfall) {
      closest = {
        pieces: chosen.map(({ p }) => ({
          name: p.name,
          itemInstanceId: p.itemInstanceId,
          slot: p.slot,
          isExotic: p.isExotic,
          stats: { ...p.stats },
          energyCapacity: p.energyCapacity,
          gearTier: p.gearTier,
        })),
        finalStats: { ...finalStats },
        shortfallByStat,
        totalShortfall: total,
      };
    }
  }

  function recordFeasible() {
    const base = zeroStats();
    for (const { own } of chosen) for (const s of STAT_ORDER) base[s] += own[s];
    for (let i = 0; i < STAT_ORDER.length; i++) base[STAT_ORDER[i]] += frag[i];
    const deficits = zeroStats();
    for (let i = 0; i < STAT_ORDER.length; i++) deficits[STAT_ORDER[i]] = Math.max(0, tgt[i] - base[STAT_ORDER[i]]);
    const chosenPieces = chosen.map((c) => ({ energyCapacity: c.p.energyCapacity }));
    const mods = allocateMods(deficits, chosenPieces);
    const finalStats = { ...base };
    for (const m of mods) finalStats[m.stat] += m.bonus;
    const energyUsed = mods.reduce((a, m) => a + m.energy, 0);
    const waste: Partial<ArmorStats> = {};
    for (const s of STAT_ORDER) {
      const w = finalStats[s] - (target[s] ?? 0);
      if (w > 0) waste[s] = w;
    }
    feasible.push({
      pieces: chosen.map(({ p }) => ({
        name: p.name,
        itemInstanceId: p.itemInstanceId,
        slot: p.slot,
        isExotic: p.isExotic,
        stats: { ...p.stats },
        energyCapacity: p.energyCapacity,
        gearTier: p.gearTier,
      })),
      baseStats: { ...base },
      finalStats: { ...finalStats },
      mods,
      energyUsed,
      energyAvailable: energySum,
      waste,
    });
  }

  function recurse(level: number) {
    if (truncated) return;
    if (feasible.length >= MAX_FEASIBLE_RESULTS) return;
    if (level === profiles.length) {
      // Full set: must satisfy set-count constraints, then mod feasibility.
      if (!setConstraintsMet()) {
        // Set constraints unmet — not a valid answer; don't record as closest
        // either (the closest should be the best *constraint-satisfying* set).
        return;
      }
      const base = zeroStats();
      for (const { own } of chosen) for (const s of STAT_ORDER) base[s] += own[s];
      for (let i = 0; i < STAT_ORDER.length; i++) base[STAT_ORDER[i]] += frag[i];
      const deficits = zeroStats();
      for (let i = 0; i < STAT_ORDER.length; i++) deficits[STAT_ORDER[i]] = Math.max(0, tgt[i] - base[STAT_ORDER[i]]);
      const bonuses = chosen.map((c) => maxModBonusOf(c.p.energyCapacity));
      if (modsCanFill(deficits, bonuses)) {
        recordFeasible();
      } else {
        // Best-effort final stats (assign the 5 mod slots greedily) for closeness.
        const finalStats = bestEffortFinal(base, bonuses, tgt);
        updateClosest(finalStats);
      }
      return;
    }

    if (++nodes > MAX_NODES) {
      truncated = true;
      return;
    }

    const prof = profiles[level];
    // Mod bound: the most any ONE stat can gain from the 5 stat-mod slots
    // (each piece's single slot, major +10 if it can afford it). Using the
    // full-set total is a loose over-estimate — safe (never false-prunes).
    const modBonusCap = totalMaxModBonus;
    const remMaxNext = remainingMaxOwn[level + 1] ?? STAT_ORDER.map(() => 0);
    const remSetSlotsNext = remainingSetSlots[level + 1] ?? setConstraints.map(() => 0);
    for (const cand of prof.candidates) {
      const own = cand.own;
      // Stat upper-bound check (never false-prunes).
      let ok = true;
      for (let i = 0; i < STAT_ORDER.length; i++) {
        const upper = sums[STAT_ORDER[i]] + own[STAT_ORDER[i]] + remMaxNext[i] + frag[i] + modBonusCap;
        if (upper < tgt[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      // Set-count bound check: after picking this candidate, can each
      // constraint still reach its minCount with the remaining set-member slots?
      if (setConstraints.length) {
        for (let ci = 0; ci < setConstraints.length; ci++) {
          const have = setCounts[ci] + (cand.sets.includes(setNames[ci]) ? 1 : 0);
          if (have + remSetSlotsNext[ci] < setConstraints[ci].minCount) {
            ok = false;
            break;
          }
        }
      }
      if (!ok) continue;

      // Commit (including set counts).
      for (const s of STAT_ORDER) sums[s] += own[s];
      energySum += cand.p.energyCapacity;
      chosen.push(cand);
      const touched: number[] = [];
      for (let ci = 0; ci < setConstraints.length; ci++) {
        if (cand.sets.includes(setNames[ci])) {
          setCounts[ci]++;
          touched.push(ci);
        }
      }

      recurse(level + 1);

      for (const ci of touched) setCounts[ci]--;
      chosen.pop();
      for (const s of STAT_ORDER) sums[s] -= own[s];
      energySum -= cand.p.energyCapacity;
    }
  }

  recurse(0);
  return { feasible, closest, truncated };
}

/**
 * Best-effort final stats when a set can't fully hit targets: assign the 5
 * stat-mod slots (one per piece, each up to its `maxModBonusOf`) greedily to
 * the largest remaining deficits (largest mod to largest deficit). Used only
 * for the "closest set" report on the NO path. `tgt` is the per-stat-index
 * target array; `bonuses` is one max-mod-bonus per chosen piece.
 */
function bestEffortFinal(base: ArmorStats, bonuses: number[], tgt: number[]): ArmorStats {
  const finalStats = { ...base };
  const defPairs = STAT_ORDER.map((s, i) => ({ s, d: Math.max(0, tgt[i] - finalStats[s]) }))
    .filter((x) => x.d > 0)
    .sort((a, b) => b.d - a.d);
  const mods = [...bonuses].filter((b) => b > 0).sort((a, b) => b - a);
  let mi = 0;
  for (const { s, d } of defPairs) {
    let need = d;
    while (need > 0 && mi < mods.length) {
      finalStats[s] += mods[mi];
      need -= mods[mi];
      mi++;
    }
  }
  return finalStats;
}

// ───────────────────────────── public API ─────────────────────────────

export function solveLoadout(pieces: LoadoutPiece[], req: LoadoutTarget): LoadoutResult {
  const target = req.target;
  const fragments = req.fragments ?? {};
  const setConstraints = req.setConstraints ?? [];
  const setNames = setConstraints.map((c) => c.name);

  // Filter to the requested class (armor's classType must match, or be "any"=3).
  const classPieces = pieces.filter(
    (p) => p.classType === req.classType || p.classType === 3,
  );

  const legendariesBySlot: Record<Slot, LoadoutPiece[]> = {
    Helmet: [], Gauntlets: [], 'Chest Armor': [], 'Leg Armor': [], 'Class Item': [],
  };
  const exoticsBySlot: Record<Slot, LoadoutPiece[]> = {
    Helmet: [], Gauntlets: [], 'Chest Armor': [], 'Leg Armor': [], 'Class Item': [],
  };
  for (const p of classPieces) {
    if (p.isExotic) exoticsBySlot[p.slot].push(p);
    else legendariesBySlot[p.slot].push(p);
  }

  // Prepare deduped, relevance-sorted, capped legendary profiles per slot.
  const legendProfile = (slot: Slot): SlotProfile => {
    const deduped = dedupByStatVector(legendariesBySlot[slot], setNames);
    const sorted = sortByRelevance(deduped, target).slice(0, MAX_CANDIDATES_PER_SLOT);
    return buildSlotProfile(sorted);
  };
  const legendProfiles: Record<Slot, SlotProfile> = {
    Helmet: legendProfile('Helmet'),
    Gauntlets: legendProfile('Gauntlets'),
    'Chest Armor': legendProfile('Chest Armor'),
    'Leg Armor': legendProfile('Leg Armor'),
    'Class Item': legendProfile('Class Item'),
  };

  // Build the list of "variants" to search. A variant is a 5-slot profile array
  // respecting the exotic constraint (at most one exotic across the set).
  const variants: SlotProfile[][] = [];

  const exoticNorm = req.exotic.trim().toLowerCase();
  if (exoticNorm === 'none') {
    variants.push(SLOTS.map((s) => legendProfiles[s]));
  } else if (exoticNorm === 'any') {
    // Try each slot as the exotic host; other slots legendary.
    for (const exoticSlot of SLOTS) {
      const exotics = exoticsBySlot[exoticSlot];
      if (!exotics.length) continue;
      const exoticDeduped = dedupByStatVector(exotics, setNames);
      const exoticSorted = sortByRelevance(exoticDeduped, target).slice(0, MAX_CANDIDATES_PER_SLOT);
      const exoticProfile = buildSlotProfile(exoticSorted);
      variants.push(SLOTS.map((s) => (s === exoticSlot ? exoticProfile : legendProfiles[s])));
    }
    // Also a fully-legendary variant (in case no exotic does better).
    variants.push(SLOTS.map((s) => legendProfiles[s]));
  } else {
    // Specific exotic by name.
    const matches = classPieces.filter(
      (p) => p.isExotic && p.name.trim().toLowerCase() === exoticNorm,
    );
    if (!matches.length) {
      return {
        feasible: false,
        sets: [],
        guidance: {
          bottleneckStat: 'Health',
          bottleneckSlot: 'Helmet',
          shortfall: 0,
          suggestedArchetypes: [],
          message: `No exotic armor named "${req.exotic}" found for this class in your vault/inventory. Check the name (it must match exactly, e.g. "Heart of Innermost Light") or use exotic: 'any' / 'none'.`,
        },
      };
    }
    // The exotic's slot is fixed to its copies; other slots legendary.
    const exoticSlot = matches[0].slot;
    const exoticProfile = buildSlotProfile(dedupByStatVector(matches, setNames));
    variants.push(SLOTS.map((s) => (s === exoticSlot ? exoticProfile : legendProfiles[s])));
  }

  // Global infeasibility shortcut: even with every slot's max stat AND all
  // energy devoted to one stat, can we reach each target? (Per-stat, generous.)
  const globalMaxByStat: Record<StatName, number> = zeroStats();
  let globalMaxEnergy = 0;
  for (const s of SLOTS) {
    // take the max across all variants' profile for that slot
    let maxOwn = zeroStats();
    let maxE = 0;
    for (const v of variants) {
      const prof = v[SLOTS.indexOf(s)];
      for (const st of STAT_ORDER) if (prof.maxOwn[st] > maxOwn[st]) maxOwn[st] = prof.maxOwn[st];
      if (prof.maxEnergy > maxE) maxE = prof.maxEnergy;
    }
    for (const st of STAT_ORDER) globalMaxByStat[st] += maxOwn[st];
    globalMaxEnergy += maxE;
  }

  let allFeasible: FeasibleSet[] = [];
  let allClosest: ClosestSet | null = null;
  let anyTruncated = false;

  // Quick global check: for each target stat, is it even conceivable?
  let globallyImpossible = false;
  for (const s of STAT_ORDER) {
    const t = target[s] ?? 0;
    if (t <= 0) continue;
    const upper = globalMaxByStat[s] + (fragments[s] ?? 0) + MAX_MOD_BONUS_PER_STAT;
    if (upper < t) {
      globallyImpossible = true;
      break;
    }
  }

  if (!globallyImpossible) {
    for (const v of variants) {
      if (allFeasible.length >= MAX_FEASIBLE_RESULTS) break;
      const r = solveVariant(v, target, fragments, setConstraints);
      if (r.truncated) anyTruncated = true;
      for (const f of r.feasible) {
        if (allFeasible.length >= MAX_FEASIBLE_RESULTS) break;
        allFeasible.push(f);
      }
      if (r.closest && (!allClosest || r.closest.totalShortfall < allClosest.totalShortfall)) {
        allClosest = r.closest;
      }
      if (allFeasible.length >= MAX_FEASIBLE_RESULTS) break;
    }
  }

  if (allFeasible.length) {
    // Rank: fewer mods used first, then less waste.
    allFeasible.sort((a, b) => a.energyUsed - b.energyUsed || sumWaste(a.waste) - sumWaste(b.waste));
    return { feasible: true, sets: allFeasible.slice(0, MAX_FEASIBLE_RESULTS), truncated: anyTruncated };
  }

  // NO path: build farm guidance from the closest set, falling back to a
  // per-variant greedy closest (respects the one-exotic limit) when the
  // exhaustive search pruned every branch.
  let closest = allClosest;
  if (!closest) {
    let greedy: ClosestSet | null = null;
    for (const v of variants) {
      const g = buildGreedyClosest(v, target, fragments, setConstraints);
      if (!greedy || g.totalShortfall < greedy.totalShortfall) greedy = g;
    }
    closest = greedy;
  }
  const guidance = buildGuidance(closest, target, fragments, globalMaxByStat, globalMaxEnergy, globallyImpossible, req);
  return { feasible: false, sets: [], closest: closest ?? undefined, guidance, truncated: anyTruncated };
}

function sumWaste(waste: Partial<ArmorStats>): number {
  return STAT_ORDER.reduce((a, s) => a + (waste[s] ?? 0), 0);
}

/**
 * Greedy "closest set" fallback for ONE variant: when the exhaustive search
 * prunes every branch (an ambitious joint target no 5-piece set can hit), no
 * full set was evaluated so `closest` is null. Build a concrete best-effort set
 * by picking, per slot, the candidate in THIS variant with the largest sum of
 * own target stats, then applying best-effort mods. Running it per variant
 * (rather than across all variants) respects the one-exotic constraint.
 *
 * Set-aware: when a set-count constraint is still unsatisfied and the current
 * slot has a member of that set, prefer the best member of the most-deficient
 * set (so the closest set honors the constraints as far as the inventory allows).
 */
function buildGreedyClosest(
  variant: SlotProfile[],
  target: Partial<ArmorStats>,
  fragments: Partial<ArmorStats>,
  setConstraints: SetConstraint[],
): ClosestSet {
  const targetStats = STAT_ORDER.filter((s) => (target[s] ?? 0) > 0);
  const tgt = STAT_ORDER.map((s) => target[s] ?? 0);
  const frag = STAT_ORDER.map((s) => fragments[s] ?? 0);
  const setNames = setConstraints.map((c) => c.name);
  const setCounts = setConstraints.map(() => 0);
  const scoreOf = (c: Cand) => targetStats.reduce((a, s) => a + c.own[s], 0);

  const chosen: Cand[] = [];
  let energySum = 0;
  for (let slotIdx = 0; slotIdx < variant.length; slotIdx++) {
    const cands = variant[slotIdx].candidates;
    // If a constraint is still short and this slot can provide a member, prefer
    // the best piece of the most-deficient such set.
    let pool = cands;
    let chosenSetIdx = -1;
    for (let ci = 0; ci < setConstraints.length; ci++) {
      const need = setConstraints[ci].minCount - setCounts[ci];
      if (need <= 0) continue;
      const members = cands.filter((c) => c.sets.includes(setNames[ci]));
      if (members.length) {
        pool = members;
        chosenSetIdx = ci;
        break;
      }
    }
    let best: Cand | null = null;
    let bestScore = -1;
    for (const c of pool) {
      const score = scoreOf(c);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best) {
      chosen.push(best);
      energySum += best.p.energyCapacity;
      if (chosenSetIdx >= 0) setCounts[chosenSetIdx]++;
      else for (let ci = 0; ci < setConstraints.length; ci++) if (best.sets.includes(setNames[ci])) setCounts[ci]++;
    }
  }

  const base = zeroStats();
  for (const { own } of chosen) for (const s of STAT_ORDER) base[s] += own[s];
  for (let i = 0; i < STAT_ORDER.length; i++) base[STAT_ORDER[i]] += frag[i];
  const bonuses = chosen.map((c) => maxModBonusOf(c.p.energyCapacity));
  const finalStats = bestEffortFinal(base, bonuses, tgt);

  const shortfallByStat: Partial<ArmorStats> = {};
  let total = 0;
  for (let i = 0; i < STAT_ORDER.length; i++) {
    const s = STAT_ORDER[i];
    const sh = Math.max(0, tgt[i] - finalStats[s]);
    if (sh > 0) {
      shortfallByStat[s] = sh;
      total += sh;
    }
  }
  return {
    pieces: chosen.map(({ p }) => ({
      name: p.name,
      itemInstanceId: p.itemInstanceId,
      slot: p.slot,
      isExotic: p.isExotic,
      stats: { ...p.stats },
      energyCapacity: p.energyCapacity,
      gearTier: p.gearTier,
    })),
    finalStats,
    shortfallByStat,
    totalShortfall: total,
  };
}

function buildGuidance(
  closest: ClosestSet | null,
  target: Partial<ArmorStats>,
  fragments: Partial<ArmorStats>,
  globalMaxByStat: Record<StatName, number>,
  globalMaxEnergy: number,
  globallyImpossible: boolean,
  req: LoadoutTarget,
): FarmGuidance {
  // Bottleneck = the target stat with the largest residual shortfall (closest set),
  // or — if no closest shortfall — the stat whose gap to the global ceiling is largest.
  let bottleneckStat: StatName = 'Health';
  let bottleneckSlot: Slot = 'Helmet';
  let shortfall = 0;

  if (closest && Object.keys(closest.shortfallByStat).length) {
    let worst = 0;
    for (const s of STAT_ORDER) {
      const sh = closest.shortfallByStat[s] ?? 0;
      if (sh > worst) {
        worst = sh;
        bottleneckStat = s;
        shortfall = sh;
      }
    }
    // Bottleneck slot = the piece in the closest set contributing least to that stat.
    if (closest.pieces.length) {
      let weakest = closest.pieces[0];
      let weakestVal = Infinity;
      for (const pc of closest.pieces) {
        const v = pc.stats[bottleneckStat] ?? 0;
        if (v < weakestVal) {
          weakestVal = v;
          weakest = pc;
        }
      }
      bottleneckSlot = weakest.slot;
    }
  } else {
    // No residual shortfall on the closest set, or no closest: fall back to the
    // global ceiling. Pick the target stat with the largest gap to its ceiling
    // (clamped to ≥ 0). This covers the "each stat individually reachable but
    // not jointly" case — there the gaps are ≤ 0, so we pick the tightest stat.
    let worst = -Infinity;
    for (const s of STAT_ORDER) {
      const t = target[s] ?? 0;
      if (t <= 0) continue;
      const upper = globalMaxByStat[s] + (fragments[s] ?? 0) + MAX_MOD_BONUS_PER_STAT;
      const gap = t - upper;
      if (gap > worst) {
        worst = gap;
        bottleneckStat = s;
      }
    }
    shortfall = Math.max(0, worst);
  }

  // Suggest archetypes whose primary or secondary covers the bottleneck stat.
  const suggestedArchetypes = Object.entries(ARCHETYPE_STATS)
    .filter(([, st]) => st.primary === bottleneckStat || st.secondary === bottleneckStat)
    .map(([name]) => name);

  // Find the second-needed stat (next target stat, excluding the bottleneck) for tertiary advice.
  const otherTargets = STAT_ORDER.filter((s) => s !== bottleneckStat && (target[s] ?? 0) > 0);
  const tertiaryHint = otherTargets[0];

  const exoticClause = req.exotic === 'any' || req.exotic === 'none' ? '' : ` while using ${req.exotic}`;

  // If a set-count constraint can't be satisfied by the inventory, say so
  // explicitly — it's a different kind of "can't build this" than a stat gap.
  const setClause = (() => {
    const cs = req.setConstraints ?? [];
    if (!cs.length || !closest) return '';
    const unmet: string[] = [];
    for (const c of cs) {
      const have = closest.pieces.filter((p) => p.name.includes(c.name)).length;
      if (have < c.minCount) unmet.push(`${c.minCount}× ${c.name} (only ${have} available in the closest set)`);
    }
    return unmet.length ? ` Set constraint unmet: ${unmet.join('; ')}.` : '';
  })();

  const message = globallyImpossible
    ? `Even devoting all your armor's best stats + every mod point to it, ${bottleneckStat} can't reach ${target[bottleneckStat]}${exoticClause}. You need to farm: a ${bottleneckSlot} (or higher-tier pieces) with a ${bottleneckStat} spike. Target a ${suggestedArchetypes[0] ?? '—'} archetype (primary ${bottleneckStat})${
        tertiaryHint ? `, tertiary ${tertiaryHint}` : ''
      }, total ≥ T73.${setClause}`
    : `Closest set is ${shortfall} short on ${bottleneckStat}. Farm a ${bottleneckSlot} with a higher ${bottleneckStat} roll — a ${suggestedArchetypes[0] ?? '—'} archetype (primary/secondary ${bottleneckStat})${
        tertiaryHint ? ` with ${tertiaryHint} tertiary` : ''
      }, total ≥ T73, will close the gap.${setClause}`;

  return { bottleneckStat, bottleneckSlot, shortfall, suggestedArchetypes, message };
}
