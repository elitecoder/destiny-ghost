import { randomBytes } from 'node:crypto';
import { createServer } from 'node:https';
import open from 'open';
import { AUTHORIZE_URL, CALLBACK_PORT, REDIRECT_URI, bungieCredentials } from './config.js';
import { resolveCert } from './certs.js';
import { exchangeCode } from './tokens.js';

/**
 * Run the full browser OAuth round-trip and persist the tokens. Opens a
 * localhost HTTPS server on CALLBACK_PORT, sends the user to Bungie's authorize
 * page, and exchanges the returned code. Resolves once tokens are stored.
 */
export async function runLogin(): Promise<void> {
  const { clientId } = bungieCredentials();
  const state = randomBytes(16).toString('hex');
  const authorizeUrl = `${AUTHORIZE_URL}?client_id=${clientId}&response_type=code&state=${state}`;
  const tls = resolveCert();

  await new Promise<void>((resolve, reject) => {
    const server = createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT_URI);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      if (url.searchParams.get('state') !== state || !code) {
        res.writeHead(400).end(page('<h2>Auth failed</h2><p>State mismatch or missing code.</p>'));
        server.close();
        reject(new Error('OAuth state mismatch or missing authorization code.'));
        return;
      }
      exchangeCode(code)
        .then(() => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(page('<h2>Authenticated ✨</h2><p>Close this tab and return to Ghost.</p>'));
          server.close();
          resolve();
        })
        .catch((err) => {
          res.writeHead(500).end(page(`<h2>Token exchange failed</h2><pre>${String(err)}</pre>`));
          server.close();
          reject(err);
        });
    });

    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      console.error('[ghost] Opening your browser to log in to Bungie…');
      console.error(`[ghost] If it doesn't open, visit:\n${authorizeUrl}`);
      if (!tls.trusted) {
        console.error('[ghost] Your browser will warn about a self-signed certificate — that is expected; proceed past it.');
        console.error('[ghost] To silence it, install mkcert (https://github.com/FiloSottile/mkcert) and run `mkcert -install`.');
      }
      void open(authorizeUrl);
    });
  });
}

const page = (body: string) =>
  `<html><head><meta charset="utf-8"></head><body style="font-family:system-ui;padding:2rem">${body}</body></html>`;
