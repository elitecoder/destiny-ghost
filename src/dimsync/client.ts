import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from '../bungie/config.js';
import { bungieCredentials } from '../bungie/config.js';
import { readTokens } from '../bungie/tokens.js';
import { getAccessToken } from '../bungie/tokens.js';
import { resolveMembership } from '../bungie/profile.js';

/**
 * DIM Sync client. DIM Sync is DIM's open-source cloud store for the tags
 * (favorite/keep/infuse/junk/archive) and notes you see in the app — it is NOT
 * part of the Bungie API, so lock/unlock and tags are two different systems.
 * The service piggybacks on Bungie.net OAuth: we already hold a Bungie access
 * token, so we register a localhost dev app once (self-serve for localhost),
 * exchange the Bungie token for a DIM token, then read/write annotations.
 *
 * Docs: https://github.com/DestinyItemManager/dim-api
 */

const DIM_API_BASE = 'https://api.destinyitemmanager.com';
const DESTINY_VERSION = 2 as const;

/** Where the registered DIM app key + cached DIM token live (0600, gitignored dir). */
const APP_PATH = join(DATA_DIR, 'dim-app.json');
const TOKEN_PATH = join(DATA_DIR, 'dim-token.json');

export type TagValue = 'favorite' | 'keep' | 'infuse' | 'junk' | 'archive';

interface DimApp {
  dimApiKey: string;
}

interface DimToken {
  accessToken: string;
  /** epoch ms when it expires (DIM has no refresh token — we just re-issue). */
  expiresAt: number;
}

export interface ItemAnnotation {
  id: string; // itemInstanceId
  tag?: TagValue | null;
  notes?: string | null;
  craftedDate?: number;
}

const readJson = async <T>(path: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
};

const writeJson = async (path: string, data: unknown): Promise<void> => {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), { mode: 0o600 });
};

/**
 * Register a localhost dev app with DIM (idempotent — cached after first run).
 * DIM lets anyone self-issue a key for a localhost origin; production keys need
 * a manual request on their Discord, which we don't need for a local tool.
 */
async function ensureApp(): Promise<{ app: DimApp; freshlyCreated: boolean }> {
  const existing = await readJson<DimApp>(APP_PATH);
  if (existing?.dimApiKey) return { app: existing, freshlyCreated: false };

  const { apiKey } = bungieCredentials();
  const res = await fetch(`${DIM_API_BASE}/new_app`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'destiny-ghost-dev',
      bungieApiKey: apiKey,
      origin: 'https://localhost:8080',
    }),
  });
  if (!res.ok) throw new Error(`DIM new_app failed (${res.status}): ${await res.text()}`);
  const body = (await res.json()) as { app?: { dimApiKey?: string }; dimApiKey?: string };
  const dimApiKey = body.dimApiKey ?? body.app?.dimApiKey;
  if (!dimApiKey) throw new Error(`DIM new_app returned no key: ${JSON.stringify(body)}`);

  const app = { dimApiKey };
  await writeJson(APP_PATH, app);
  return { app, freshlyCreated: true };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Exchange the Bungie access token for a DIM access token. Cached until ~2 min
 * before expiry; DIM has no refresh token, so we just re-issue the same call.
 */
async function getDimToken(): Promise<{ token: string; dimApiKey: string }> {
  const { app, freshlyCreated } = await ensureApp();
  const dimApiKey = app.dimApiKey;
  const cached = await readJson<DimToken>(TOKEN_PATH);
  if (cached && cached.expiresAt - 2 * 60_000 > Date.now()) {
    return { token: cached.accessToken, dimApiKey };
  }

  const bungieAccessToken = await getAccessToken();
  const stored = await readTokens();
  if (!stored) throw new Error('Not authenticated with Bungie — run `npm run auth`.');

  // DIM caches registered apps in memory and refreshes ~every 60–70s, so a
  // just-registered app 401s (NoAppFound) until the next refresh. On first
  // registration only, retry across that window instead of failing.
  const maxAttempts = freshlyCreated ? 8 : 1;
  let lastErr = '';
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(`${DIM_API_BASE}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': dimApiKey },
      body: JSON.stringify({ bungieAccessToken, membershipId: stored.membershipId }),
    });
    if (res.ok) {
      const body = (await res.json()) as { accessToken: string; expiresInSeconds: number };
      await writeJson(TOKEN_PATH, {
        accessToken: body.accessToken,
        expiresAt: Date.now() + body.expiresInSeconds * 1000,
      } satisfies DimToken);
      return { token: body.accessToken, dimApiKey };
    }
    lastErr = `${res.status}: ${await res.text()}`;
    if (res.status === 401 && lastErr.includes('NoAppFound') && attempt < maxAttempts - 1) {
      await sleep(15_000);
      continue;
    }
    break;
  }
  throw new Error(`DIM /auth/token failed (${lastErr})`);
}

async function authHeaders(): Promise<Record<string, string>> {
  const { token, dimApiKey } = await getDimToken();
  return {
    'Content-Type': 'application/json',
    'X-API-Key': dimApiKey,
    Authorization: `Bearer ${token}`,
  };
}

/** The Steam/platform membershipId DIM keys the profile on (not the Bungie.net id). */
async function platformMembershipId(): Promise<string> {
  return (await resolveMembership()).membershipId;
}

/** Read all current item annotations (tags + notes) for this profile. */
export async function getAnnotations(): Promise<ItemAnnotation[]> {
  const platformId = await platformMembershipId();
  const url = new URL(`${DIM_API_BASE}/profile`);
  url.searchParams.set('platformMembershipId', platformId);
  url.searchParams.set('destinyVersion', String(DESTINY_VERSION));
  url.searchParams.set('components', 'tags');
  const res = await fetch(url, { headers: await authHeaders() });
  if (!res.ok) throw new Error(`DIM GET /profile failed (${res.status}): ${await res.text()}`);
  const body = (await res.json()) as { tags?: ItemAnnotation[] };
  return body.tags ?? [];
}

/**
 * Set (or clear) the DIM tag on one or more items. Pass tag=null to clear.
 * Bulk — DIM applies the whole `updates` list in one POST.
 */
export async function setTags(
  items: Array<{ itemInstanceId: string; tag: TagValue | null }>,
): Promise<{ results: unknown }> {
  const platformId = await platformMembershipId();
  const updates = items.map((it) => ({
    action: 'tag' as const,
    payload: { id: it.itemInstanceId, tag: it.tag } satisfies ItemAnnotation,
  }));
  const res = await fetch(`${DIM_API_BASE}/profile`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({
      platformMembershipId: platformId,
      destinyVersion: DESTINY_VERSION,
      updates,
    }),
  });
  if (!res.ok) throw new Error(`DIM POST /profile failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as { results: unknown };
}
