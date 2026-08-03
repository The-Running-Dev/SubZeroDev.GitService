import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sha256Hex, type GitSha, type Sha256Hex } from '../shared/brands.ts';
import { timingSafeStringEqual } from '../shared/timing-safe.ts';
import type { AuditChainState } from '../audit/types.ts';
import type { CredentialFailureMark } from '../credentials/types.ts';
import { NO_VOLUME_USAGE, type VolumeUsage } from '../store/volume-usage.ts';
import { handleConsoleAuthRoute, type ConsoleAuthDependencies } from './console-auth-routes.ts';

/**
 * `LivenessReport` is the sole unauthenticated payload in the whole service
 * (invariant E8) — `ready` and `commitSha`, nothing else. `VersionReport` is
 * an authenticated console route.
 */
export interface LivenessReport {
  readonly ready: boolean;
  readonly commitSha: GitSha;
}

export interface VersionReport {
  readonly commitSha: GitSha;
  readonly contractFingerprint: Sha256Hex;
  readonly consoleFingerprint: Sha256Hex;
}

/**
 * The console asset manifest doesn't exist until S19, so there is nothing
 * real to fingerprint yet. This is the SHA-256 of the empty string, clearly
 * a placeholder rather than a real manifest hash.
 */
export const NO_CONSOLE_FINGERPRINT: Sha256Hex = (() => {
  const result = sha256Hex(createHash('sha256').update('').digest('hex'));
  if (!result.ok) throw new Error('unreachable: sha256 of empty string is always 64 hex chars');
  return result.value;
})();

/**
 * `20-contract.md` § L5 surfaces. Authenticated, unlike `/healthz`.
 * `auditChain` is real as of S3; `failedOutboxRows`, `failingCredentialRefs`,
 * `parkedOperations` and `volume` are genuinely zero/empty until the modules
 * that would populate them exist (Notifier, Credentials, Journal, S17's
 * volume accounting) — not placeholders standing in for unmeasured data, but
 * true statements that nothing has happened yet in subsystems that do not run.
 */
export interface HealthReport {
  readonly ready: boolean;
  readonly provisioningPending: boolean;
  readonly version: VersionReport;
  readonly auditChain: AuditChainState;
  readonly failedOutboxRows: number;
  readonly failingCredentialRefs: readonly CredentialFailureMark[];
  readonly parkedOperations: number;
  readonly volume: VolumeUsage;
}

export interface SurfacesDependencies extends ConsoleAuthDependencies {
  readonly commitSha: GitSha;
  readonly contractFingerprint: Sha256Hex;
  readonly consoleFingerprint: Sha256Hex;
  readonly ready: () => boolean;
  /**
   * Live, not a boot-time snapshot: enrolment can complete without a
   * restart, so `/health` has to ask the operator identity module on every
   * request rather than report what boot observed once.
   */
  readonly provisioningPending: () => Promise<boolean>;
  readonly auditChain: () => Promise<AuditChainState>;
  /**
   * A shared-secret bearer check standing in for the L4 Authorization module
   * (S13 onward), which this slice does not touch. Good enough to prove
   * "authenticated route, 401 without a credential" without building OAuth.
   */
  readonly operatorApiToken: string;
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return false;
  }
  return timingSafeStringEqual(header.slice('Bearer '.length), token);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function handleRequest(deps: SurfacesDependencies, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname.startsWith('/auth/')) {
    const handled = await handleConsoleAuthRoute(deps, req, res, url);
    if (handled) return;
  }

  if (req.method === 'GET' && url.pathname === '/healthz') {
    const report: LivenessReport = { ready: deps.ready(), commitSha: deps.commitSha };
    sendJson(res, 200, report);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/version') {
    if (!isAuthorized(req, deps.operatorApiToken)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    const report: VersionReport = {
      commitSha: deps.commitSha,
      contractFingerprint: deps.contractFingerprint,
      consoleFingerprint: deps.consoleFingerprint,
    };
    sendJson(res, 200, report);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    if (!isAuthorized(req, deps.operatorApiToken)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    const auditChain = await deps.auditChain();
    const report: HealthReport = {
      ready: deps.ready(),
      provisioningPending: await deps.provisioningPending(),
      version: { commitSha: deps.commitSha, contractFingerprint: deps.contractFingerprint, consoleFingerprint: deps.consoleFingerprint },
      auditChain,
      failedOutboxRows: 0,
      failingCredentialRefs: [],
      parkedOperations: 0,
      volume: NO_VOLUME_USAGE,
    };
    sendJson(res, 200, report);
    return;
  }

  sendJson(res, 404, { error: 'not-found' });
}

export function createSurfacesServer(deps: SurfacesDependencies): Server {
  return createServer((req, res) => {
    // The rejection path is load-bearing, not defensive tidiness. `createServer`
    // takes a synchronous callback, so an async handler's rejection has nowhere
    // to go: without this it becomes an unhandled rejection and Node exits the
    // process. That would hand anyone who can make a handler throw — by
    // corrupting the audit trail, say — a way to stop the service, which is
    // exactly the property `10-design.md` refuses for a broken chain.
    handleRequest(deps, req, res).catch(() => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, 500, { error: 'internal-error' });
    });
  });
}
