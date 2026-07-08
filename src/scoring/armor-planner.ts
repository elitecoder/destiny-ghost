/**
 * Armor keeper planning for multi-copy vault cleanup.
 *
 * Unlike weapons (deduped by light.gg combos), legendary armor dedups by:
 *   archetype (the intrinsic perk: Gunner/Grenadier/…) → tertiary stat → total.
 * Two hard rules learned the hard way:
 *   1. NEVER keep a piece purely to fill a tertiary slot if it's a weak roll —
 *      a low total is not worth a vault slot. Enforced by `minTotal` (the floor).
 *   2. Power level is irrelevant to armor quality; only the stat total + spread
 *      matter (see the weapon-side lesson about low power ≠ low quality).
 * Set bonuses and build-fit are NOT modeled here — the operator vetoes those.
 */

export interface ArmorPiece {
  itemInstanceId: string;
  /** The archetype perk name, e.g. "Gunner". Empty/undefined for old armor. */
  archetype?: string;
  /** Total of all six stats. */
  total: number;
  /** The tertiary stat name (the varying third stat beyond the archetype pair). */
  tertiary: string;
}

export interface ArmorPlan {
  keepers: string[];
  /** Everything not kept — dismantle candidates. */
  rejects: string[];
  /** Kept pieces, grouped, for display. */
  keptByArchetype: Record<string, string[]>;
  /** Pieces dropped SOLELY because they fell below the minTotal floor. */
  belowFloor: string[];
}

export interface ArmorPlanOptions {
  /** Archetypes to keep (per-tertiary). Any archetype not listed is all-reject. */
  keepArchetypes: string[];
  /** Minimum stat total to keep ANY piece. Below this → reject, floor rule. */
  minTotal: number;
  /** Keep the top-N per tertiary within a kept archetype (default 1). */
  perTertiary?: number;
}

/**
 * Plan armor keepers: within each kept archetype, keep the top-`perTertiary`
 * pieces per tertiary stat — but ONLY pieces at or above `minTotal`. A piece
 * below the floor is never kept, even as the sole copy of its tertiary (the
 * "don't keep T54 garbage to fill a slot" rule). Archetypes not in
 * `keepArchetypes` are fully rejected. Old armor (no archetype) is rejected.
 */
export function planArmorKeepers(pieces: ArmorPiece[], opts: ArmorPlanOptions): ArmorPlan {
  const perTertiary = opts.perTertiary ?? 1;
  const keepSet = new Set(opts.keepArchetypes);
  const keptByArchetype: Record<string, string[]> = {};
  const keepers: string[] = [];
  const rejects: string[] = [];
  const belowFloor: string[] = [];

  // Group by archetype.
  const byArch: Record<string, ArmorPiece[]> = {};
  for (const p of pieces) {
    const key = p.archetype && p.archetype.length ? p.archetype : '(old)';
    (byArch[key] ??= []).push(p);
  }

  for (const [arch, list] of Object.entries(byArch)) {
    if (!keepSet.has(arch)) {
      // Not a kept archetype (incl. old armor) → all reject.
      rejects.push(...list.map((p) => p.itemInstanceId));
      continue;
    }
    // Within a kept archetype: group by tertiary, keep top-N above the floor.
    const byTert: Record<string, ArmorPiece[]> = {};
    for (const p of list) (byTert[p.tertiary] ??= []).push(p);

    for (const group of Object.values(byTert)) {
      group.sort((a, b) => b.total - a.total);
      let keptInGroup = 0;
      for (const p of group) {
        if (keptInGroup < perTertiary && p.total >= opts.minTotal) {
          keepers.push(p.itemInstanceId);
          (keptByArchetype[arch] ??= []).push(p.itemInstanceId);
          keptInGroup++;
        } else {
          rejects.push(p.itemInstanceId);
          // Flag pieces that WOULD have been kept but for the floor.
          if (keptInGroup < perTertiary && p.total < opts.minTotal) {
            belowFloor.push(p.itemInstanceId);
          }
        }
      }
    }
  }

  return { keepers, rejects, keptByArchetype, belowFloor };
}
