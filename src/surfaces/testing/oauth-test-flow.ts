import { createHash, randomBytes } from 'node:crypto';

const DEFAULT_CLIENT_REDIRECT_URI = 'https://client.invalid/callback';

/**
 * Shared between `mcp-routes.test.ts` (Node-side `fetch` against an
 * in-process server) and `console.spec.ts` (Playwright's own Node-side test
 * code, not `page.evaluate`) — neither `/oauth/register` nor `/oauth/token`
 * needs the browser's session cookie, only the `/oauth/authorize` approval
 * step does, and that one stays driven from inside the page.
 */
export function pkce(): { readonly verifier: string; readonly challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export async function registerClient(
  baseUrl: string,
  redirectUris: readonly string[] = [DEFAULT_CLIENT_REDIRECT_URI],
  clientName = 'test client',
): Promise<{ client_id: string }> {
  const registerResponse = await fetch(`${baseUrl}/oauth/register`, {
    method: 'POST',
    body: JSON.stringify({ redirect_uris: redirectUris, client_name: clientName }),
  });
  if (registerResponse.status !== 201) {
    throw new Error(`client registration failed: ${registerResponse.status} ${await registerResponse.text()}`);
  }
  return (await registerResponse.json()) as { client_id: string };
}

export async function exchangeCodeForTokens(
  baseUrl: string,
  clientId: string,
  code: string,
  verifier: string,
  redirectUri: string = DEFAULT_CLIENT_REDIRECT_URI,
): Promise<{ status: number; body: string }> {
  const tokenResponse = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  return { status: tokenResponse.status, body: await tokenResponse.text() };
}
