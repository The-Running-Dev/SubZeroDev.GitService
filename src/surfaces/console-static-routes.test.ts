import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { systemClock } from '../clock/clock.ts';
import { createAudit } from '../audit/audit.ts';
import { createOperatorIdentity } from '../operator-identity/operator-identity.ts';
import { createAuthorization } from '../authorization/authorization.ts';
import { createSurfacesServer, NO_CONSOLE_FINGERPRINT } from './http-server.ts';
import { createMcpRoutesState } from './mcp-routes.ts';
import type { GitSha, Sha256Hex } from '../shared/brands.ts';
import { createStubDeclarations } from '../declarations/testing/stub-declarations.ts';
import { createStubCloneStore } from '../clone/testing/stub-clone-store.ts';
import { createStubDispatchPipeline } from '../dispatch/testing/stub-dispatch-pipeline.ts';
import type { ContractCapabilitySet, DeploymentCeiling } from '../contract/capabilities.ts';

const COMMIT_SHA = '0'.repeat(40) as GitSha;
const CONTRACT_FINGERPRINT = '1'.repeat(64) as Sha256Hex;
const CEILING = new Set(['repo.read']) as unknown as ContractCapabilitySet;

async function writeConsoleBundle(dir: string): Promise<void> {
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><div id="root">shell</div>', 'utf8');
  await writeFile(path.join(dir, 'assets', 'index-abc123.js'), 'console.log("bundle");', 'utf8');
  await writeFile(path.join(dir, 'console.manifest.sha256'), 'deadbeef\n', 'utf8');
}

async function withServer<T>(volume: string, consoleDir: string | undefined, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const audit = createAudit({ volumeRoot: volume, clock: systemClock });
  const credentialMount = path.join(volume, '_credential-mount');
  await mkdir(credentialMount, { recursive: true });
  const identity = createOperatorIdentity({ volumeRoot: volume, credentialMountRoot: credentialMount, clock: systemClock, audit });
  const authorization = createAuthorization({
    volumeRoot: volume,
    clock: systemClock,
    contractCapabilitySet: CEILING,
    ceiling: CEILING as unknown as DeploymentCeiling,
    declarations: createStubDeclarations(),
    audit,
  });
  const server = createSurfacesServer({
    commitSha: COMMIT_SHA,
    contractFingerprint: CONTRACT_FINGERPRINT,
    consoleFingerprint: NO_CONSOLE_FINGERPRINT,
    ready: () => true,
    provisioningPending: async () => (await identity.provisioningState()) === 'pending',
    auditChain: async () => ({ verifiedThrough: null, headHash: null, mirroredHeadHash: null, retainedAnchors: [], chainBreak: null }),
    authorization,
    identity,
    sessionAbsoluteSeconds: 43_200,
    declarations: createStubDeclarations(),
    cloneStore: createStubCloneStore(),
    dispatchPipeline: createStubDispatchPipeline(),
    contractCapabilitySet: CEILING,
    origin: 'http://localhost',
    mcpState: createMcpRoutesState(),
    ...(consoleDir ? { consoleDir } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('S18.9 — the console shell and its built assets are served unauthenticated, and every data route still answers 401', async () => {
  const volume = await mkdtemp(path.join(tmpdir(), 'console-static-'));
  const consoleDir = await mkdtemp(path.join(tmpdir(), 'console-dist-'));
  try {
    await writeConsoleBundle(consoleDir);
    await withServer(volume, consoleDir, async (baseUrl) => {
      const shell = await fetch(`${baseUrl}/`);
      assert.equal(shell.status, 200);
      assert.match(shell.headers.get('content-type') ?? '', /text\/html/);
      assert.match(await shell.text(), /id="root"/);

      const asset = await fetch(`${baseUrl}/assets/index-abc123.js`);
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get('content-type') ?? '', /javascript/);

      const spaFallback = await fetch(`${baseUrl}/some/client-side/route`);
      assert.equal(spaFallback.status, 200, 'an unrecognised path still gets the shell, not a 404');
      assert.match(await spaFallback.text(), /id="root"/);

      // The hash companion the boot check reads is never itself servable.
      const hashFile = await fetch(`${baseUrl}/console.manifest.sha256`);
      assert.equal(hashFile.status, 200, 'falls through to the SPA shell rather than exposing the raw file');
      assert.match(await hashFile.text(), /id="root"/);

      // Every data route in the table still answers 401 unauthenticated.
      const declarationsRes = await fetch(`${baseUrl}/declarations`);
      assert.equal(declarationsRes.status, 401);
      const healthRes = await fetch(`${baseUrl}/health`);
      assert.equal(healthRes.status, 401);
      const versionRes = await fetch(`${baseUrl}/version`);
      assert.equal(versionRes.status, 401);
    });
  } finally {
    await rm(volume, { recursive: true, force: true });
    await rm(consoleDir, { recursive: true, force: true });
  }
});

test('a server built without a console directory serves no static content and still 404s cleanly', async () => {
  const volume = await mkdtemp(path.join(tmpdir(), 'console-static-'));
  try {
    await withServer(volume, undefined, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/`);
      assert.equal(res.status, 404);
    });
  } finally {
    await rm(volume, { recursive: true, force: true });
  }
});
