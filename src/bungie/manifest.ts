import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getDestinyManifest } from 'bungie-api-ts/destiny2';
import { MANIFEST_DIR } from './config.js';
import { anonHttp, manifestUrl } from './client.js';

/**
 * The definition tables we cache. Item defs cover weapons/armor/mods/shaders;
 * the rest resolve the sockets/perks/stats we surface in item detail. Keeping
 * this list small keeps the on-disk cache lean.
 */
const TABLES = [
  'DestinyInventoryItemDefinition',
  'DestinyStatDefinition',
  'DestinySocketTypeDefinition',
  'DestinyPlugSetDefinition',
  'DestinyInventoryBucketDefinition',
  'DestinyDamageTypeDefinition',
  'DestinyClassDefinition',
  'DestinyRecordDefinition',
  'DestinyPresentationNodeDefinition',
  'DestinyObjectiveDefinition',
  'DestinyChecklistDefinition',
] as const;
export type ManifestTable = (typeof TABLES)[number];

/** A hash-keyed table of definitions. Definitions are `any` — Bungie's shape. */
type DefTable = Record<number, any>;

interface LoadedManifest {
  version: string;
  tables: Record<ManifestTable, DefTable>;
}

let cached: LoadedManifest | null = null;

const versionFile = () => join(MANIFEST_DIR, 'version.txt');
const tablePath = (v: string, t: ManifestTable) => join(MANIFEST_DIR, v, `${t}.json`);

/**
 * Ensure the manifest for the current content version is downloaded to disk,
 * then load it into memory. Event-driven: re-downloads only when Bungie's
 * content version hash changes. Safe to call repeatedly (cheap after warm).
 */
export async function ensureManifest(): Promise<LoadedManifest> {
  const meta = (await getDestinyManifest(anonHttp)).Response;
  const version = meta.version;
  if (cached?.version === version) return cached;

  const paths = meta.jsonWorldComponentContentPaths.en as Record<string, string>;
  await mkdir(join(MANIFEST_DIR, version), { recursive: true });

  const tables = {} as Record<ManifestTable, DefTable>;
  for (const table of TABLES) {
    const local = tablePath(version, table);
    let json: DefTable;
    try {
      json = JSON.parse(await readFile(local, 'utf8')) as DefTable;
    } catch {
      const remotePath = paths[table];
      if (!remotePath) throw new Error(`Manifest is missing table ${table}`);
      const res = await fetch(manifestUrl(remotePath));
      if (!res.ok) throw new Error(`Failed to download ${table} (${res.status})`);
      json = (await res.json()) as DefTable;
      await writeFile(local, JSON.stringify(json));
    }
    tables[table] = json;
  }

  await writeFile(versionFile(), version);
  await pruneOldVersions(version);

  const loaded: LoadedManifest = { version, tables };
  cached = loaded;
  return loaded;
}

/** Remove stale version directories so the cache doesn't grow unbounded. */
async function pruneOldVersions(keep: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(MANIFEST_DIR);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((e) => e !== keep && e !== 'version.txt')
      .map((e) => rm(join(MANIFEST_DIR, e), { recursive: true, force: true })),
  );
}

function table(t: ManifestTable): DefTable {
  if (!cached) throw new Error('Manifest not loaded — call ensureManifest() first.');
  return cached.tables[t];
}

export function itemDef(hash: number): any | undefined {
  return table('DestinyInventoryItemDefinition')[hash];
}
export function statDef(hash: number): any | undefined {
  return table('DestinyStatDefinition')[hash];
}
export function bucketDef(hash: number): any | undefined {
  return table('DestinyInventoryBucketDefinition')[hash];
}
export function damageTypeDef(hash: number): any | undefined {
  return table('DestinyDamageTypeDefinition')[hash];
}
export function classDef(hash: number): any | undefined {
  return table('DestinyClassDefinition')[hash];
}
export function recordDef(hash: number): any | undefined {
  return table('DestinyRecordDefinition')[hash];
}
export function presentationNodeDef(hash: number): any | undefined {
  return table('DestinyPresentationNodeDefinition')[hash];
}
export function objectiveDef(hash: number): any | undefined {
  return table('DestinyObjectiveDefinition')[hash];
}
export function checklistDef(hash: number): any | undefined {
  return table('DestinyChecklistDefinition')[hash];
}

/** Human-readable name for an item definition hash. */
export function itemName(hash: number): string {
  return itemDef(hash)?.displayProperties?.name ?? `Unknown item ${hash}`;
}
