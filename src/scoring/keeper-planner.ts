/**
 * Keeper planning for multi-copy vault cleanup, grounded in light.gg data.
 *
 * The failure this guards against: choosing "good" perks from memory (e.g.
 * asserting Collective Action or Withering Gaze is a keeper perk) instead of
 * from the community data actually fetched. Every function here takes the
 * PARSED light.gg combos as input and derives the good-perk set FROM them — so
 * a perk that light.gg never listed cannot enter the keeper rationale.
 */

/** One community combo from light.gg: two trait perks and its usage share. */
export interface LightGgCombo {
  trait1: string;
  trait2: string;
  pct: number;
}

/** A vault copy reduced to its two selectable trait columns. */
export interface CopyRolls {
  itemInstanceId: string;
  powerLevel: number;
  /** All selectable perks in the Trait-1 column. */
  trait1Options: string[];
  /** All selectable perks in the Trait-2 column. */
  trait2Options: string[];
  /**
   * Every perk selectable ANYWHERE on the copy (all columns, incl. barrel/mag).
   * Used by a required-perk gate — e.g. a grenade launcher must be able to roll
   * a usable grenade type (Spike/Disorienting) or the trait perks are moot.
   * Optional: omit to skip the gate.
   */
  allOptions?: string[];
}

/**
 * A hard prerequisite: the copy must be able to roll at least one of these
 * perks (in any column) to be eligible as a keeper. For grenade launchers this
 * is the grenade type — without a usable grenade the trait combo is dead.
 */
export type RequiredAnyOf = string[];

/** A combo a specific copy can actually roll (both perks selectable on it). */
export interface ReachableCombo {
  itemInstanceId: string;
  combo: LightGgCombo;
}

/**
 * Parse the combo section of a fetched light.gg item page. Matches the
 * `.perk-names` → `.combo-percent` structure. Returns only rows that parse to
 * two named perks and a numeric percent, sorted by usage descending. Rows like
 * stat bars ("Range", ".0%") are dropped by the two-perk + positive-pct guard.
 */
/**
 * Normalize a perk name for matching. light.gg suffixes enhanced perks with an
 * asterisk ("Voltshot*"); a copy rolling the base "Voltshot" is the same perk
 * for keeper purposes, so strip the marker (and surrounding whitespace).
 */
export function normalizePerkName(name: string): string {
  return name.replace(/\*+\s*$/, '').trim();
}

export function parseLightGgCombos(html: string): LightGgCombo[] {
  const blocks = [
    ...html.matchAll(
      /<div class="perk-names">([\s\S]*?)<\/div>\s*<div class="combo-percent">\s*([\d.]+)%/g,
    ),
  ];
  const combos: LightGgCombo[] = [];
  for (const [, namesHtml, pctStr] of blocks) {
    const names = [...namesHtml.matchAll(/<div>\+?\s*([^<]+?)\s*<\/div>/g)].map((m) =>
      normalizePerkName(m[1]),
    );
    const pct = parseFloat(pctStr);
    if (names.length === 2 && names[0] && names[1] && pct > 0) {
      combos.push({ trait1: names[0], trait2: names[1], pct });
    }
  }
  return combos.sort((a, b) => b.pct - a.pct);
}

/**
 * The good-perk set is derived from the combos, never supplied by hand.
 * A perk is "good" iff it appears in at least one fetched combo.
 */
export function goodPerksFromCombos(combos: LightGgCombo[]): { trait1: Set<string>; trait2: Set<string> } {
  const trait1 = new Set<string>();
  const trait2 = new Set<string>();
  for (const c of combos) {
    trait1.add(c.trait1);
    trait2.add(c.trait2);
  }
  return { trait1, trait2 };
}

/**
 * Which fetched combos each copy can actually roll — both perks selectable in
 * the copy's respective columns. This is the only sanctioned justification for
 * keeping a copy.
 */
export function reachableCombos(copies: CopyRolls[], combos: LightGgCombo[]): ReachableCombo[] {
  const out: ReachableCombo[] = [];
  for (const copy of copies) {
    // Normalize both sides so a base perk matches an enhanced (asterisked) name.
    const t1 = new Set(copy.trait1Options.map(normalizePerkName));
    const t2 = new Set(copy.trait2Options.map(normalizePerkName));
    for (const combo of combos) {
      if (t1.has(normalizePerkName(combo.trait1)) && t2.has(normalizePerkName(combo.trait2))) {
        out.push({ itemInstanceId: copy.itemInstanceId, combo });
      }
    }
  }
  return out;
}

/**
 * Greedy set-cover: the fewest copies that together cover every REACHABLE
 * combo. Ties broken toward the copy covering the most still-uncovered combos,
 * then higher power. Returns keeper ids plus which combos each covers, and any
 * fetched combos that no copy can roll (surface these to the user — do not
 * silently drop them).
 *
 * `requiredAnyOf` is a hard prerequisite gate: a copy that cannot roll any of
 * the required perks (checked against `allOptions`, falling back to the two
 * trait columns) is dropped before cover — its trait combos don't count. This
 * is how the grenade-type filter works (keep only Spike/Disorienting copies).
 */
export function planKeepers(
  copies: CopyRolls[],
  combos: LightGgCombo[],
  requiredAnyOf?: RequiredAnyOf,
): {
  keepers: Array<{ itemInstanceId: string; covers: LightGgCombo[] }>;
  unreachableCombos: LightGgCombo[];
  ineligible: string[];
} {
  let eligible = copies;
  const ineligible: string[] = [];
  if (requiredAnyOf && requiredAnyOf.length) {
    const req = new Set(requiredAnyOf.map(normalizePerkName));
    eligible = [];
    for (const c of copies) {
      const pool = (c.allOptions ?? [...c.trait1Options, ...c.trait2Options]).map(normalizePerkName);
      if (pool.some((p) => req.has(p))) eligible.push(c);
      else ineligible.push(c.itemInstanceId);
    }
  }
  const reachable = reachableCombos(eligible, combos);
  const comboKey = (c: LightGgCombo) => `${c.trait1}|${c.trait2}`;

  const reachableKeys = new Set(reachable.map((r) => comboKey(r.combo)));
  const unreachableCombos = combos.filter((c) => !reachableKeys.has(comboKey(c)));

  // itemInstanceId → set of combo keys it can roll.
  const byCopy = new Map<string, { copy: CopyRolls; keys: Set<string> }>();
  for (const r of reachable) {
    const copy = eligible.find((c) => c.itemInstanceId === r.itemInstanceId)!;
    if (!byCopy.has(r.itemInstanceId)) byCopy.set(r.itemInstanceId, { copy, keys: new Set() });
    byCopy.get(r.itemInstanceId)!.keys.add(comboKey(r.combo));
  }

  const uncovered = new Set(reachableKeys);
  const keepers: Array<{ itemInstanceId: string; covers: LightGgCombo[] }> = [];
  const comboByKey = new Map(combos.map((c) => [comboKey(c), c]));

  while (uncovered.size > 0) {
    let best: { id: string; gain: number; power: number } | null = null;
    for (const [id, { copy, keys }] of byCopy) {
      if (keepers.some((k) => k.itemInstanceId === id)) continue;
      const gain = [...keys].filter((k) => uncovered.has(k)).length;
      if (gain === 0) continue;
      if (!best || gain > best.gain || (gain === best.gain && copy.powerLevel > best.power)) {
        best = { id, gain, power: copy.powerLevel };
      }
    }
    if (!best) break; // no copy covers any remaining combo
    const keys = byCopy.get(best.id)!.keys;
    const covers = [...keys].filter((k) => uncovered.has(k)).map((k) => comboByKey.get(k)!);
    keepers.push({ itemInstanceId: best.id, covers });
    for (const k of keys) uncovered.delete(k);
  }

  return { keepers, unreachableCombos, ineligible };
}
