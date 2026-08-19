import { tmpdir } from 'node:os';
import path from 'node:path';

/** Shared between `run-server.ts` (which seeds the fixture instance) and `console.spec.ts` (which drives it). */
export const E2E_PROVISIONING_SECRET = 'e2e-bootstrap-secret';
export const E2E_SUBJECT = 'operator';
export const E2E_PASSWORD = 'correct horse battery staple e2e';
export const E2E_PORT = 8099;
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
export const E2E_VOLUME_ROOT = path.join(tmpdir(), 'szg-e2e-volume');
export const E2E_CREDENTIAL_MOUNT_ROOT = path.join(tmpdir(), 'szg-e2e-credentials');
