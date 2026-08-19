import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PROVISIONING_FILENAME, TOTP_SEALING_KEY_FILENAME } from '../src/operator-identity/operator-identity.ts';
import { E2E_CREDENTIAL_MOUNT_ROOT, E2E_PORT, E2E_PROVISIONING_SECRET, E2E_VOLUME_ROOT } from './constants.ts';

/**
 * S18.13's fixture instance: a fresh volume and credential mount, seeded
 * with a TOTP sealing key and a provisioning secret, then the real
 * `src/server.ts` started against them — the same server the deployed
 * container runs, not a mock. Playwright's `webServer` (`playwright.config.ts`)
 * runs this once per test run and waits for `/healthz` before the browser
 * tests start.
 */

const volumeRoot = E2E_VOLUME_ROOT;
const credentialMountRoot = E2E_CREDENTIAL_MOUNT_ROOT;

rmSync(volumeRoot, { recursive: true, force: true });
rmSync(credentialMountRoot, { recursive: true, force: true });
mkdirSync(volumeRoot, { recursive: true });
mkdirSync(credentialMountRoot, { recursive: true });

writeFileSync(path.join(credentialMountRoot, TOTP_SEALING_KEY_FILENAME), randomBytes(32));
writeFileSync(path.join(volumeRoot, PROVISIONING_FILENAME), `${E2E_PROVISIONING_SECRET}\n`, 'utf8');

process.env.VOLUME_ROOT = volumeRoot;
process.env.CREDENTIAL_MOUNT_ROOT = credentialMountRoot;
process.env.PORT = String(E2E_PORT);
// `console.spec.ts` declares one real repository through the real HTTP API
// to exercise S18.2's landing view — declaring validates the URL's host
// against this allowlist but performs no clone (S5: "clones itself on first
// use"), so this needs no outbound network access to succeed.
process.env.REMOTE_HOST_ALLOWLIST = 'github.com';

await import('../src/server.ts');
