import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { DATA_DIR, TOKENS_PATH, TOKEN_URL, bungieCredentials } from './config.js';

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** epoch ms when the access token expires */
  accessExpiresAt: number;
  /** epoch ms when the refresh token expires */
  refreshExpiresAt: number;
  membershipId: string;
  /** Space-separated OAuth scopes granted at auth time (for verification). */
  scope?: string;
}

interface BungieTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_expires_in: number;
  membership_id: string;
  scope?: string;
}

/** Refresh the access token this many ms before it actually expires. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export async function readTokens(): Promise<StoredTokens | null> {
  try {
    return JSON.parse(await readFile(TOKENS_PATH, 'utf8')) as StoredTokens;
  } catch {
    return null;
  }
}

export async function writeTokens(tokens: StoredTokens): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(TOKENS_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

export async function clearTokens(): Promise<boolean> {
  const existing = await readTokens();
  await rm(TOKENS_PATH, { force: true });
  return existing !== null;
}

function toStored(res: BungieTokenResponse): StoredTokens {
  const now = Date.now();
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    accessExpiresAt: now + res.expires_in * 1000,
    refreshExpiresAt: now + res.refresh_expires_in * 1000,
    membershipId: res.membership_id,
    scope: res.scope,
  };
}

async function postToken(params: Record<string, string>): Promise<StoredTokens> {
  const { clientId, clientSecret } = bungieCredentials();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) {
    throw new Error(`Bungie token request failed (${res.status}): ${await res.text()}`);
  }
  return toStored((await res.json()) as BungieTokenResponse);
}

/** Exchange an authorization code for tokens (first login). */
export async function exchangeCode(code: string): Promise<StoredTokens> {
  const tokens = await postToken({ grant_type: 'authorization_code', code });
  await writeTokens(tokens);
  return tokens;
}

/**
 * Return a valid access token, refreshing if it's within the refresh margin.
 * Throws (prompting re-login) if there are no tokens or the refresh token has
 * itself expired.
 */
export async function getAccessToken(): Promise<string> {
  const tokens = await readTokens();
  if (!tokens) {
    throw new Error('Not authenticated. Run `npm run auth` to log in to Bungie.');
  }
  if (tokens.accessExpiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return tokens.accessToken;
  }
  if (tokens.refreshExpiresAt <= Date.now()) {
    throw new Error('Bungie session expired. Run `npm run auth` to log in again.');
  }
  const refreshed = await postToken({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
  });
  await writeTokens(refreshed);
  return refreshed.accessToken;
}
