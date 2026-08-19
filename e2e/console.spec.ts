import { test, expect } from '@playwright/test';
import { writeBreakGlassToken } from '../src/operator-identity/operator-identity.ts';
import { base32Decode, currentTotpCode } from '../src/operator-identity/totp.ts';
import { E2E_PASSWORD, E2E_PROVISIONING_SECRET, E2E_SUBJECT, E2E_VOLUME_ROOT } from './constants.ts';

/**
 * S18.13 — enrolment, all three sign-in paths and the landing view, driven
 * end to end in a real browser against a real repository. One test, in
 * order: the enrolment step's recovery codes and TOTP secret are only ever
 * shown once, so every later step's credentials come from what this same
 * run captured, not from a fixture written in advance.
 */
test('S18.12/S18.13/S18.10/S18.2 — enrolment, every sign-in path, and the landing view, against a real repository', async ({ page }) => {
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

  // --- Path 2: recovery code ---
  await page.getByTestId('tab-recovery-code').click();
  await page.getByTestId('recovery-subject').fill(E2E_SUBJECT);
  await page.getByTestId('recovery-password').fill(E2E_PASSWORD);
  await page.getByTestId('recovery-code').fill(recoveryCodes[0]!);
  await page.getByRole('button', { name: 'Sign in with recovery code' }).click();
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
});
