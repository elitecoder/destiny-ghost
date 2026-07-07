import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from '../bungie/config.js';

/**
 * God-roll scoring via the DIM community wishlist ("voltron.txt"), the same
 * upstream source Destiny Recipes uses. We consume the license-clean upstream
 * directly (48klocs/dim-wish-list-sources) rather than scraping anyone's API.
 *
 * A wishlist line looks like:
 *   dimwishlist:item=1234567890&perks=111,222,333#notes:PvE god roll
 * We index perks per item hash, split by PvE/PvP tag from the notes, and score
 * a rolled weapon by how many wishlisted perks it actually has.
 */
const VOLTRON_URL =
  'https://raw.githubusercontent.com/48klocs/dim-wish-list-sources/master/voltron.txt';
const CACHE_PATH = join(DATA_DIR, 'voltron.txt');
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // refresh daily

export type RollTag = 'pve' | 'pvp' | 'any';

interface WishRoll {
  perks: Set<number>;
  tag: RollTag;
}

interface Wishlist {
  version: string; // the cache mtime ISO, surfaced in verdicts
  byItem: Map<number, WishRoll[]>;
}

let cached: Wishlist | null = null;

async function fetchText(): Promise<{ text: string; version: string }> {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    const s = await stat(CACHE_PATH);
    if (Date.now() - s.mtimeMs < MAX_AGE_MS) {
      return { text: await readFile(CACHE_PATH, 'utf8'), version: s.mtime.toISOString() };
    }
  } catch {
    /* not cached yet */
  }
  const res = await fetch(VOLTRON_URL);
  if (!res.ok) {
    // Fall back to a stale cache if the download fails.
    try {
      const s = await stat(CACHE_PATH);
      return { text: await readFile(CACHE_PATH, 'utf8'), version: `${s.mtime.toISOString()} (stale)` };
    } catch {
      throw new Error(`Failed to download wishlist (${res.status}) and no cache exists.`);
    }
  }
  const text = await res.text();
  await writeFile(CACHE_PATH, text);
  return { text, version: new Date().toISOString() };
}

function tagFromNotes(notes: string): RollTag {
  const n = notes.toLowerCase();
  if (n.includes('pvp') || n.includes('crucible') || n.includes('trials')) return 'pvp';
  if (n.includes('pve') || n.includes('raid') || n.includes('nightfall')) return 'pve';
  return 'any';
}

export async function loadWishlist(force = false): Promise<Wishlist> {
  if (cached && !force) return cached;
  const { text, version } = await fetchText();
  const byItem = new Map<number, WishRoll[]>();

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('dimwishlist:item=')) continue;
    const [spec, notes = ''] = trimmed.split('#notes:');
    const itemMatch = spec.match(/item=(-?\d+)/);
    if (!itemMatch) continue;
    // A leading '-' marks a trashlist entry; treat abs value as the item hash.
    const itemHash = Math.abs(Number(itemMatch[1]));
    const perksMatch = spec.match(/perks=([\d,]+)/);
    const perks = new Set(
      (perksMatch?.[1] ?? '')
        .split(',')
        .map(Number)
        .filter((n) => n > 0),
    );
    if (perks.size === 0) continue;
    const rolls = byItem.get(itemHash) ?? [];
    rolls.push({ perks, tag: tagFromNotes(notes) });
    byItem.set(itemHash, rolls);
  }

  cached = { version, byItem };
  return cached;
}

export interface RollScore {
  /** 0..1 — best fraction of any single wishlisted roll's perks that are present. */
  score: number;
  /** S/A/B/C/D/F tier derived from the score. */
  tier: string;
  /** How many wishlist rolls exist for this item under the requested tag. */
  matchedRolls: number;
  /** True when this exact item hash has any wishlist entry at all. */
  hasWishlist: boolean;
  wishlistVersion: string;
}

const tierFor = (score: number): string => {
  if (score >= 1) return 'S';
  if (score >= 0.8) return 'A';
  if (score >= 0.6) return 'B';
  if (score >= 0.4) return 'C';
  if (score >= 0.2) return 'D';
  return 'F';
};

/**
 * Score a rolled weapon: the best per-roll fraction of wishlisted perks it
 * actually has, filtered to the requested activity tag ('any' considers all).
 */
export async function scoreRoll(
  itemHash: number,
  plugHashes: number[],
  tag: RollTag = 'any',
): Promise<RollScore> {
  const wl = await loadWishlist();
  const rolls = (wl.byItem.get(itemHash) ?? []).filter((r) => tag === 'any' || r.tag === tag || r.tag === 'any');
  const present = new Set(plugHashes);

  let best = 0;
  for (const roll of rolls) {
    let hit = 0;
    for (const p of roll.perks) if (present.has(p)) hit++;
    best = Math.max(best, hit / roll.perks.size);
  }

  return {
    score: best,
    tier: rolls.length === 0 ? 'unrated' : tierFor(best),
    matchedRolls: rolls.length,
    hasWishlist: wl.byItem.has(itemHash),
    wishlistVersion: wl.version,
  };
}
