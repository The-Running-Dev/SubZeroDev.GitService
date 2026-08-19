import { test, expect } from '@playwright/test';
import { writeBreakGlassToken } from '../src/operator-identity/operator-identity.ts';
import { base32Decode, currentTotpCode } from '../src/operator-identity/totp.ts';
import { pkce, registerClient, exchangeCodeForTokens } from '../src/surfaces/testing/oauth-test-flow.ts';
import { E2E_BASE_URL, E2E_PASSWORD, E2E_PROVISIONING_SECRET, E2E_SUBJECT, E2E_VOLUME_ROOT } from './constants.ts';

/**
 * S18.13 — enrolment, all three sign-in paths and the landing view, driven
 * end to end in a real browser against a real repository. One test, in
 * order: the enrolment step's recovery codes and TOTP secret are only ever
 * shown once, so every later step's credentials come from what this same
 * run captured, not from a fixture written in advance.
 *
 * S32.4 continues in the same test, against the same signed-in browser
 * session and the same declared `e2e-repo` — a fresh test would need its own
 * sign-in, and the whole point of this file's single-test shape is that the
 * enrolment secrets it captures are only ever available once.
 */
test('S18.12/S18.13/S18.10/S18.2/S31.4/S31.5/S32.1/S32.2/S32.3/S32.4 — enrolment, every sign-in path, the lockout round trip, the landing view, and the grants view against a real repository', async ({ page }) => {
  // S18.12 — a brand new instance shows the enrolment screen and no other.
  await page.goto('/');
  await expect(page.getByTestId('provisioning-secret')).toBeVisible();
  await expect(page.getByTestId('login-subject')).not.toBeVisible();

  await page.getByTestId('provisioning-secret').fill(E2E_PROVISIONING_SECRET);
  await page.getByTestId('enrol-subject').fill(E2E_SUBJECT);
  await page.getByTestId('enrol-password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Enrol' }).click();

  // Recovery codes and the TOTP secret are shown exactly once.
  await expect(page.getByTestId('recovery-codes')).toBeVisible();
  const recoveryCodes = await page.getByTestId('recovery-codes').locator('li').allTextContents();
  expect(recoveryCodes.length).toBe(10);
  const totpSecretText = await page.locator('code').textContent();
  expect(totpSecretText).toBeTruthy();
  const totpSecret = base32Decode(totpSecretText!);

  await page.getByRole('button', { name: 'Continue to sign in' }).click();
  await expect(page.getByTestId('login-subject')).toBeVisible();

  // Declared below via the real HTTP API — S18.13 runs against a real
  // repository, not an empty instance. A real, always-reachable public
  // GitHub URL rather than a local bare remote: declaring only validates
  // the URL's host against the allowlist and persists a row (S5: "clones
  // itself on first use"), so this needs no outbound git operation to
  // succeed, and the host has to be a real one on `REMOTE_HOST_ALLOWLIST`.
  const remoteUrl = 'https://github.com/octocat/Hello-World.git';

  // --- Path 1: password + TOTP ---
  await page.getByTestId('login-subject').fill(E2E_SUBJECT);
  await page.getByTestId('login-password').fill(E2E_PASSWORD);
  await page.getByTestId('login-totp').fill(currentTotpCode(totpSecret));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('declaration-list')).toBeVisible();

  // S18.10 — a bearer token on a cookie route, and a cookie on a bearer
  // route, are each refused. Demonstrated against the live session this
  // page just established, not asserted.
  const bearerOnCookieRoute = await page.evaluate(async () => {
    // `credentials: 'omit'` is load-bearing here: a same-origin `fetch`
    // defaults to `'same-origin'`, which would carry this page's own session
    // cookie regardless of the bearer header and defeat the isolation this
    // is meant to demonstrate.
    const res = await fetch('/declarations', { credentials: 'omit', headers: { Authorization: 'Bearer not-a-real-token' } });
    return res.status;
  });
  expect(bearerOnCookieRoute, 'a bearer token alone does not satisfy a cookie route').toBe(401);

  const cookieOnBearerRoute = await page.evaluate(async () => {
    // `credentials: 'omit'` still carries the browser's ambient cookie for a
    // same-origin fetch unless explicitly suppressed — flip it off so this
    // request truly carries no Authorization header and relies on nothing
    // but the cookie the page already holds, then show `/health` (bearer
    // route) refuses it anyway.
    const res = await fetch('/health', { credentials: 'include' });
    return res.status;
  });
  expect(cookieOnBearerRoute, 'a cookie alone does not satisfy a bearer route').toBe(401);

  const mutationWithoutCsrfToken = await page.evaluate(async () => {
    const res = await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
    return res.status;
  });
  expect(mutationWithoutCsrfToken, 'a mutating cookie request with no double-submit token is refused').toBe(403);

  await page.getByTestId('sign-out').click();
  await expect(page.getByTestId('login-subject')).toBeVisible();

  // --- Path 2: recovery code, then S31.4/S31.5's lockout round trip ---
  await page.getByTestId('tab-recovery-code').click();
  await page.getByTestId('recovery-subject').fill(E2E_SUBJECT);
  await page.getByTestId('recovery-password').fill(E2E_PASSWORD);
  await page.getByTestId('recovery-code').fill(recoveryCodes[0]!);
  await page.getByRole('button', { name: 'Sign in with recovery code' }).click();

  // S31.4 — a recovery-code sign-in forces re-enrolment; the console routes
  // here instead of the landing view.
  await expect(page.getByTestId('reenrol-secret')).toBeVisible();
  const reenrolSecretText = await page.getByTestId('reenrol-secret').textContent();
  expect(reenrolSecretText).toBeTruthy();
  const newTotpSecret = base32Decode(reenrolSecretText!);

  // A wrong code leaves the old secret's re-enrolment incomplete.
  await page.getByTestId('reenrol-totp').fill('000000');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('alert')).toBeVisible();

  await page.getByTestId('reenrol-totp').fill(currentTotpCode(newTotpSecret));
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByTestId('declaration-list')).toBeVisible();
  await page.getByTestId('sign-out').click();
  await expect(page.getByTestId('login-subject')).toBeVisible();

  // S31.5 — the same recovery code is refused the second time.
  await page.getByTestId('tab-recovery-code').click();
  await page.getByTestId('recovery-subject').fill(E2E_SUBJECT);
  await page.getByTestId('recovery-password').fill(E2E_PASSWORD);
  await page.getByTestId('recovery-code').fill(recoveryCodes[0]!);
  await page.getByRole('button', { name: 'Sign in with recovery code' }).click();
  await expect(page.getByRole('alert')).toBeVisible();

  // S31.5 — signs in with the new authenticator.
  await page.getByTestId('tab-password').click();
  await page.getByTestId('login-subject').fill(E2E_SUBJECT);
  await page.getByTestId('login-password').fill(E2E_PASSWORD);
  await page.getByTestId('login-totp').fill(currentTotpCode(newTotpSecret));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('declaration-list')).toBeVisible();
  await page.getByTestId('sign-out').click();
  await expect(page.getByTestId('login-subject')).toBeVisible();

  // --- Path 3: break-glass ---
  const breakGlassToken = 'e2e-break-glass-token';
  writeBreakGlassToken(E2E_VOLUME_ROOT, breakGlassToken);
  await page.getByTestId('tab-break-glass').click();
  await page.getByTestId('break-glass-token').fill(breakGlassToken);
  await page.getByRole('button', { name: 'Sign in with break-glass token' }).click();
  await expect(page.getByTestId('declaration-list')).toBeVisible();

  // S18.2 — the landing view lists the declared repository with its clone
  // state, and selecting it survives a reload. Declared through the
  // browser's own `fetch` (`page.evaluate`), the same way the app itself
  // ever calls this route, rather than `page.request` — Chromium exempts
  // `127.0.0.1` from the `Secure` cookie requirement (the loopback
  // trustworthy-origin exception this whole harness runs under, since there
  // is no TLS in front of the fixture server), but Playwright's own
  // `APIRequestContext` does not share that exemption and silently drops
  // the session cookie, which reads as `session-unknown` and is not what
  // this step is testing.
  const declareResult = await page.evaluate(
    async ({ cloneUrl }) => {
      const csrfToken = document.cookie.match(/(?:^|; )szg_csrf=([^;]+)/)?.[1] ?? '';
      const res = await fetch('/declarations', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({
          id: 'e2e-repo',
          cloneUrl,
          host: 'generic',
          credentialRef: 'unused',
          capabilityGrant: [],
          writablePathPrefixes: [],
          pinned: false,
          fileWatcher: null,
          identity: { gitUserName: 'e2e', gitUserEmail: 'e2e@example.com' },
        }),
      });
      return { status: res.status, body: await res.text() };
    },
    { cloneUrl: remoteUrl },
  );
  expect(declareResult.status, `declare failed: ${declareResult.status} ${declareResult.body}`).toBe(201);

  await page.reload();
  await expect(page.getByTestId('declaration-row-e2e-repo')).toBeVisible();
  await page.getByTestId('declaration-row-e2e-repo').click();
  await expect(page.getByTestId('selected-declaration')).toHaveText('Selected: e2e-repo');

  await page.reload();
  await expect(page.getByTestId('declaration-list')).toBeVisible();
  await expect(page.getByTestId('selected-declaration')).toHaveText('Selected: e2e-repo');

  // --- S32 — the grants view revokes everything, including live MCP sessions and the operator's own session ---

  await page.getByTestId('nav-grants').click();
  await expect(page.getByTestId('client-list')).toBeVisible();
  await expect(page.getByTestId('mcp-grant-list')).toBeVisible();
  await expect(page.getByTestId('operator-token-list')).toBeVisible();
  await expect(page.getByTestId('operator-session-list')).toBeVisible();

  // Exactly one operator session is live at this point — every earlier
  // sign-in on this run was cleanly signed out first — and it is this
  // page's own, the case S32.3 asks for.
  const liveSessionRows = page.locator('[data-testid="operator-session-list"] tbody tr').filter({ hasText: 'no' });
  await expect(liveSessionRows).toHaveCount(1);

  // Register a real MCP client and drive it through the real PKCE
  // authorization-code flow to establish a genuinely live MCP session — S32.4
  // asks for a registered client and a live MCP session, not a stub.
  // Registration and the token exchange below need no browser session (they
  // are unauthenticated per `mcp-routes.ts`), so both run as plain Node-side
  // calls through the same `oauth-test-flow.ts` helpers `mcp-routes.test.ts`
  // uses, rather than a second copy of the request shapes driven through
  // `page.evaluate`. Only the `/oauth/authorize` approval step below carries
  // the operator's session cookie and stays in-page for that reason.
  const CLIENT_REDIRECT_URI = 'https://client.invalid/callback';
  const { verifier, challenge } = pkce();

  const client = await registerClient(E2E_BASE_URL, [CLIENT_REDIRECT_URI], 'S32 e2e client');
  expect(client.client_id).toBeTruthy();

  const authorizeUrl = new URL('/oauth/authorize', 'https://placeholder.invalid');
  authorizeUrl.searchParams.set('client_id', client.client_id);
  authorizeUrl.searchParams.set('redirect_uri', CLIENT_REDIRECT_URI);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('resource', '/mcp/e2e-repo');
  authorizeUrl.searchParams.set('scope', 'read');

  const { requestId } = await page.evaluate(
    async ({ path }) => {
      const res = await fetch(path, { credentials: 'same-origin' });
      const html = await res.text();
      const match = /name="request_id" value="([^"]+)"/.exec(html);
      return { requestId: match ? match[1] : null };
    },
    { path: authorizeUrl.pathname + authorizeUrl.search },
  );
  expect(requestId, 'the approval form must carry a request_id').toBeTruthy();

  // The approval POST 302-redirects to the client's own redirect URI, which
  // resolves to nothing real. A real browser `fetch` cannot read a
  // cross-origin redirect's `Location` (opaque in `redirect: 'manual'`
  // mode, and a same-site follow triggers a genuine network request to a
  // host that doesn't resolve) — so the request is driven through
  // `page.route`'s own `route.fetch`, which runs outside the page's CORS
  // and redirect-following rules and can read the header directly, the same
  // way `mcp-routes.test.ts`'s Node-side `fetch` does for this exact step.
  let authorizeLocation: string | null = null;
  await page.route('**/oauth/authorize', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    const response = await route.fetch({ maxRedirects: 0 });
    authorizeLocation = response.headers()['location'] ?? null;
    await route.fulfill({ response });
  });

  await page.evaluate(
    async ({ requestId }) => {
      const csrfToken = document.cookie.match(/(?:^|; )szg_csrf=([^;]+)/)?.[1] ?? '';
      try {
        await fetch('/oauth/authorize', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': csrfToken },
          body: new URLSearchParams({ request_id: requestId!, action: 'approve' }).toString(),
        });
      } catch {
        // The fulfilled response is the real 302; the in-page `fetch` then
        // tries to follow it to a host that doesn't resolve. Irrelevant —
        // `authorizeLocation` above already captured the header server-side.
      }
    },
    { requestId },
  );
  await page.unroute('**/oauth/authorize');

  expect(authorizeLocation, 'the approval must redirect to the client redirect URI carrying a code').toBeTruthy();
  const code = new URL(authorizeLocation!).searchParams.get('code');
  expect(code).toBeTruthy();

  const tokenResponse = await exchangeCodeForTokens(E2E_BASE_URL, client.client_id, code!, verifier, CLIENT_REDIRECT_URI);
  expect(tokenResponse.status, tokenResponse.body).toBe(200);
  const tokens = JSON.parse(tokenResponse.body) as { access_token: string };
  expect(tokens.access_token).toBeTruthy();

  const initialized = await page.evaluate(
    async ({ accessToken }) => {
      const res = await fetch('/mcp/e2e-repo', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      return { status: res.status };
    },
    { accessToken: tokens.access_token },
  );
  expect(initialized.status, 'the MCP client must reach a genuinely live session').toBe(200);

  // S32.1/S32.2/S32.4 — the newly registered client and its MCP grant are
  // visible from the reloaded view, with the last-used timestamp the
  // `initialize` call above just wrote.
  await page.getByTestId('grants-back').click();
  await page.getByTestId('nav-grants').click();
  const clientRow = page.getByTestId(`client-row-${client.client_id}`);
  await expect(clientRow).toBeVisible();
  await expect(clientRow).not.toContainText('never');

  const grantRow = page.locator('[data-testid="mcp-grant-list"] tbody tr').filter({ hasText: 'e2e-repo' });
  await expect(grantRow).toHaveCount(1);
  await expect(grantRow).not.toContainText('never');

  // S32.2 — revoking the client from the view runs S13's cascade: the
  // client itself is marked revoked, and — demonstrated below rather than
  // read off this row, since the cascade lives in `grantIsLive`'s upward
  // walk (`authorization.ts`) rather than a second `revoked_at` write on
  // every grant it touches — its grant's tokens stop authorizing.
  await page.getByTestId(`revoke-client-${client.client_id}`).click();
  await expect(page.getByTestId(`revoke-client-${client.client_id}`)).toBeDisabled();
  await expect(page.getByTestId(`client-revoked-${client.client_id}`)).not.toHaveText('no');

  // S32.4 — the live MCP session established above no longer authorizes,
  // demonstrated against the real transport rather than asserted from the
  // view.
  const afterRevoke = await page.evaluate(
    async ({ accessToken }) => {
      const res = await fetch('/mcp/e2e-repo', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }),
      });
      return { status: res.status };
    },
    { accessToken: tokens.access_token },
  );
  expect(afterRevoke.status, 'a revoked client\'s MCP session must no longer authorize').toBe(401);

  // S32.3 — revoking the operator's own session from the same view signs
  // them out: the incident case the design names by name.
  await liveSessionRows.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByTestId('login-subject')).toBeVisible();
});
