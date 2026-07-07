import type { HttpClientConfig } from 'bungie-api-ts/http';
import { BUNGIE_ROOT, bungieCredentials } from './config.js';
import { getAccessToken } from './tokens.js';

/**
 * Bungie PlatformErrorCodes that mean "you're throttled; back off". The API
 * also returns a `ThrottleSeconds` field telling you how long to wait — the
 * contract is: on one of these codes, sleep ThrottleSeconds then retry.
 * (Community "~25 req/s" numbers are NOT authoritative — we obey the field.)
 */
const THROTTLE_CODES = new Set([31, 35, 36, 37, 51, 52, 53, 54, 55, 56, 57, 1672, 2004]);

export class BungieError extends Error {
  constructor(
    readonly errorStatus: string,
    readonly errorCode: number,
    message: string,
    readonly throttleSeconds = 0,
  ) {
    super(`Bungie error ${errorStatus} (${errorCode}): ${message}`);
    this.name = 'BungieError';
  }
}

interface BungieEnvelope<T> {
  Response: T;
  ErrorCode: number;
  ErrorStatus: string;
  Message: string;
  ThrottleSeconds?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The single HTTP function every bungie-api-ts call receives. Adds the API key
 * + bearer token (for authed calls), and retries throttle codes using the
 * server-provided ThrottleSeconds. Returns the FULL Bungie envelope — the
 * bungie-api-ts endpoint wrappers are typed to receive `ServerResponse<T>` and
 * read `.Response` themselves, so we must not pre-unwrap here.
 *
 * @param auth when true, attach the OAuth bearer token (required for private
 *   inventory reads and all write actions).
 */
export function makeHttp(auth: boolean, maxThrottleRetries = 4) {
  return async function $http<T>(cfg: HttpClientConfig): Promise<T> {
    const { apiKey } = bungieCredentials();

    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { 'X-API-Key': apiKey };
      if (auth) headers.Authorization = `Bearer ${await getAccessToken()}`;
      if (cfg.body !== undefined) headers['Content-Type'] = 'application/json';

      const url = new URL(cfg.url);
      if (cfg.params) {
        for (const [k, v] of Object.entries(cfg.params)) {
          if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
        }
      }

      const res = await fetch(url.toString(), {
        method: cfg.method,
        headers,
        body: cfg.body === undefined ? undefined : JSON.stringify(cfg.body),
      });

      // Bungie almost always returns a JSON envelope even on error; guard anyway.
      let envelope: BungieEnvelope<unknown>;
      try {
        envelope = (await res.json()) as BungieEnvelope<unknown>;
      } catch {
        throw new Error(`Bungie non-JSON response (${res.status}) from ${cfg.url}`);
      }

      if (envelope.ErrorCode === 1) return envelope as T;

      const throttle = envelope.ThrottleSeconds ?? 0;
      if (THROTTLE_CODES.has(envelope.ErrorCode) && attempt < maxThrottleRetries) {
        await sleep(Math.max(throttle, 1) * 1000);
        continue;
      }
      throw new BungieError(
        envelope.ErrorStatus,
        envelope.ErrorCode,
        envelope.Message,
        throttle,
      );
    }
  };
}

/** Authenticated client — for GetProfile (private components) and all writes. */
export const authedHttp = makeHttp(true);
/** Unauthenticated client — for the public manifest metadata endpoint. */
export const anonHttp = makeHttp(false);

/** Absolute URL for a manifest-relative path (e.g. jsonWorldContentPaths). */
export const manifestUrl = (path: string) => `${BUNGIE_ROOT}${path}`;
