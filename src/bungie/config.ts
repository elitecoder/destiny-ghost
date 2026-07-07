import { config as loadEnv } from 'dotenv';
import { homedir } from 'node:os';
import { join } from 'node:path';

loadEnv();

/**
 * Bungie OAuth + API configuration. All three values come from a Bungie app
 * registered at https://www.bungie.net/en/Application (OAuth client type:
 * Confidential; redirect URL must equal REDIRECT_URI below; scopes: read
 * inventory/vault + move-or-equip gear). Supply them via .env — never commit.
 */
export const BUNGIE_ROOT = 'https://www.bungie.net';
export const BUNGIE_PLATFORM = `${BUNGIE_ROOT}/Platform`;
export const AUTHORIZE_URL = `${BUNGIE_ROOT}/en/OAuth/Authorize`;
export const TOKEN_URL = `${BUNGIE_PLATFORM}/App/OAuth/token/`;

export const CALLBACK_PORT = 7777;
export const REDIRECT_URI = `https://127.0.0.1:${CALLBACK_PORT}/callback`;

/** All persistent state (tokens, manifest cache, wishlist) lives here. */
export const DATA_DIR = process.env.GHOST_DATA_DIR || join(homedir(), '.destiny-ghost');
export const TOKENS_PATH = join(DATA_DIR, 'tokens.json');
export const MANIFEST_DIR = join(DATA_DIR, 'manifest');
export const CERT_DIR = join(DATA_DIR, 'certs');

export interface BungieCredentials {
  apiKey: string;
  clientId: string;
  clientSecret: string;
}

export function bungieCredentials(): BungieCredentials {
  const apiKey = process.env.BUNGIE_API_KEY;
  const clientId = process.env.BUNGIE_CLIENT_ID;
  const clientSecret = process.env.BUNGIE_CLIENT_SECRET;
  if (!apiKey || !clientId || !clientSecret) {
    throw new Error(
      'Missing Bungie credentials. Set BUNGIE_API_KEY, BUNGIE_CLIENT_ID, and ' +
        'BUNGIE_CLIENT_SECRET in .env — register an app at ' +
        'https://www.bungie.net/en/Application (redirect URL ' +
        `${REDIRECT_URI}).`,
    );
  }
  return { apiKey, clientId, clientSecret };
}

