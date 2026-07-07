import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CERT_DIR } from './config.js';

export interface Cert {
  key: string;
  cert: string;
  /** True when browser-trusted (mkcert); false for a raw self-signed cert. */
  trusted: boolean;
}

/**
 * Resolve a TLS cert for the localhost OAuth callback. Bungie requires an
 * https redirect URI. If `mkcert` is installed we mint a browser-trusted cert;
 * otherwise we fall back to an openssl self-signed cert (browser warns once).
 */
export function resolveCert(): Cert {
  mkdirSync(CERT_DIR, { recursive: true });
  const keyPath = join(CERT_DIR, '127.0.0.1-key.pem');
  const certPath = join(CERT_DIR, '127.0.0.1.pem');

  if (mkcertAvailable()) {
    if (!existsSync(keyPath) || !existsSync(certPath)) {
      execFileSync('mkcert', ['-key-file', keyPath, '-cert-file', certPath, '127.0.0.1', 'localhost'], {
        stdio: 'ignore',
      });
    }
    return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8'), trusted: true };
  }

  if (!existsSync(keyPath) || !existsSync(certPath)) {
    // openssl ships with macOS/Linux; RSA 2048 so OpenSSL 3.x accepts it.
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365',
        '-keyout', keyPath, '-out', certPath,
        '-subj', '/CN=127.0.0.1',
        '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
      ],
      { stdio: 'ignore' },
    );
  }
  return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8'), trusted: false };
}

function mkcertAvailable(): boolean {
  try {
    execFileSync('mkcert', ['-CAROOT'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
