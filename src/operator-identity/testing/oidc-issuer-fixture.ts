import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

/**
 * S31.2/S31.3 — "a real issuer", not a stub that always succeeds. A real
 * `node:http` server implementing OIDC discovery, JWKS, `/authorize` (a real
 * page a browser could navigate and click through) and `/token` (a real
 * authorization-code exchange, RS256-signed via `jose`). Self-contained: no
 * external account, no Docker. See `design/90-decisions.md`, 2026-08-19,
 * "S31's 'real issuer' is a hand-built OIDC provider fixture".
 *
 * S31.3's "genuinely unreachable" is this fixture's own port after `stop()`
 * — a real closed TCP port a caller's `fetch` gets `ECONNREFUSED` against,
 * not a configuration flag standing in for the same claim.
 */
export interface OidcIssuerFixture {
  readonly issuerUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Builds an `/authorize` URL that completes immediately as `subject`, standing in for a browser clicking through the fixture's consent page. */
  authorizeUrl(params: { readonly redirectUri: string; readonly state: string; readonly subject: string }): string;
  stop(): Promise<void>;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function startOidcIssuerFixture(): Promise<OidcIssuerFixture> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const kid = randomUUID();
  const jwk = await exportJWK(publicKey);
  const clientId = 'e2e-console-client';
  const clientSecret = 'e2e-console-secret';

  const issuedCodes = new Map<string, { readonly subject: string; usedAt: number | null }>();
  let issuerUrl = '';

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', issuerUrl || 'http://127.0.0.1');

      if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            issuer: issuerUrl,
            authorization_endpoint: `${issuerUrl}/authorize`,
            token_endpoint: `${issuerUrl}/token`,
            jwks_uri: `${issuerUrl}/jwks`,
          }),
        );
        return;
      }

      if (req.method === 'GET' && url.pathname === '/jwks') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ keys: [{ ...jwk, kid, use: 'sig', alg: 'RS256' }] }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/authorize') {
        const redirectUri = url.searchParams.get('redirect_uri') ?? '';
        const state = url.searchParams.get('state') ?? '';
        const subject = url.searchParams.get('sub');
        if (!subject) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!doctype html>
<html><body>
<h1>Fixture issuer</h1>
<form method="GET" action="/authorize">
  <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}" />
  <input type="hidden" name="state" value="${escapeHtml(state)}" />
  <label>Subject <input type="text" name="sub" data-testid="oidc-fixture-subject" /></label>
  <button type="submit" data-testid="oidc-fixture-approve">Approve</button>
</form>
</body></html>`);
          return;
        }
        const code = randomUUID();
        issuedCodes.set(code, { subject, usedAt: null });
        const location = new URL(redirectUri);
        location.searchParams.set('code', code);
        location.searchParams.set('state', state);
        res.writeHead(302, { Location: location.toString() });
        res.end();
        return;
      }

      if (req.method === 'POST' && url.pathname === '/token') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const code = params.get('code') ?? '';
        const entry = issuedCodes.get(code);
        if (!entry || entry.usedAt !== null) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        entry.usedAt = Date.now();

        const idToken = await new SignJWT({ sub: entry.subject })
          .setProtectedHeader({ alg: 'RS256', kid })
          .setIssuer(issuerUrl)
          .setAudience(clientId)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id_token: idToken, access_token: randomUUID(), token_type: 'Bearer' }));
        return;
      }

      res.writeHead(404);
      res.end();
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('oidc-issuer-fixture: failed to bind a port');
  issuerUrl = `http://127.0.0.1:${address.port}`;

  return {
    issuerUrl,
    clientId,
    clientSecret,
    authorizeUrl({ redirectUri, state, subject }) {
      const url = new URL(`${issuerUrl}/authorize`);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      url.searchParams.set('sub', subject);
      return url.toString();
    },
    async stop() {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
