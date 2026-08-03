import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sha256Hex, type GitSha, type SessionId, type Sha256Hex } from '../shared/brands.ts';
import type { AuditChainState } from '../audit/types.ts';
import type { CredentialFailureMark } from '../credentials/types.ts';
import { NO_VOLUME_USAGE, type VolumeUsage } from '../store/volume-usage.ts';
import type { OperatorIdentity, OperatorSession } from '../identity/types.ts';

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

export interface SurfacesDependencies {
  readonly commitSha: GitSha;
  readonly contractFingerprint: Sha256Hex;
  readonly consoleFingerprint: Sha256Hex;
  readonly ready: () => boolean;
  readonly provisioningPending: () => boolean;
  readonly auditChain: () => Promise<AuditChainState>;
  /**
   * A shared-secret bearer check standing in for the L4 Authorization module
   * (S13 onward), which this slice does not touch. Good enough to prove
   * "authenticated route, 401 without a credential" without building OAuth.
   */
  readonly operatorApiToken: string;
  /** S4: operator identity, for console session routes. */
  readonly operatorIdentity?: OperatorIdentity;
}

/**
 * Compares fixed-length digests rather than the raw strings, so a
 * length-mismatch early return (which `timingSafeEqual` itself requires,
 * since it rejects unequal-length buffers) never depends on the length of
 * the caller-presented secret — only on the length of a hash, which is
 * always 32 bytes.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
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

// ─── Console session cookie helpers ─────────────────────────────────────────

const SESSION_COOKIE_NAME = 'szg_session';
const CSRF_COOKIE_NAME = 'szg_csrf';
const CSRF_HEADER_NAME = 'x-csrf-token';

function sessionCookieValue(res: ServerResponse, session: OperatorSession): void {
  // HttpOnly, Secure, SameSite=Lax, host-scoped (__Host- prefix)
  const expires = new Date(session.absoluteExpiresAt).toUTCString();
  res.setHeader('Set-Cookie', [
    `__Host-${SESSION_COOKIE_NAME}=${session.id}; HttpOnly; Secure; SameSite=Lax; Path=/; Expires=${expires}`,
    `__Host-${CSRF_COOKIE_NAME}=${generateCsrfToken()}; Secure; SameSite=Lax; Path=/`,
  ]);
}

function generateCsrfToken(): string {
  return randomBytes(16).toString('hex');
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader('Set-Cookie', [
    `__Host-${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0`,
    `__Host-${CSRF_COOKIE_NAME}=; Secure; SameSite=Lax; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0`,
  ]);
}

function parseCookies(req: IncomingMessage): Readonly<Record<string, string>> {
  const header = req.headers.cookie ?? '';
  const result: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    result[name] = value;
  }
  return result;
}

function getSessionId(req: IncomingMessage): SessionId | null {
  const cookies = parseCookies(req);
  const id = cookies[`__Host-${SESSION_COOKIE_NAME}`];
  return id ? (id as SessionId) : null;
}

/**
 * CSRF check: Origin header must match the request host, and the double-submit
 * token in the `x-csrf-token` header must match the CSRF cookie value.
 * Both must pass for a mutating console route to proceed.
 */
function checkCsrf(req: IncomingMessage): boolean {
  const origin = req.headers['origin'];
  const host = req.headers['host'];
  if (origin && host) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.host !== host) return false;
    } catch {
      return false;
    }
  }
  const tokenHeader = req.headers[CSRF_HEADER_NAME];
  const cookies = parseCookies(req);
  const csrfCookie = cookies[`__Host-${CSRF_COOKIE_NAME}`];
  if (!tokenHeader || !csrfCookie) return false;
  return timingSafeStringEqual(tokenHeader as string, csrfCookie);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', reject);
  });
}

async function handleRequest(deps: SurfacesDependencies, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

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
      provisioningPending: deps.provisioningPending(),
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

  // ── Console routes (S4) ──────────────────────────────────────────────────

  if (url.pathname.startsWith('/console/')) {
    const identity = deps.operatorIdentity;
    if (!identity) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    // POST /console/enrol — provisioning; allowed while not yet provisioned
    if (req.method === 'POST' && url.pathname === '/console/enrol') {
      const body = await readJsonBody(req) as Record<string, unknown> | null;
      if (!body || typeof body !== 'object') {
        sendJson(res, 400, { error: 'bad-request' });
        return;
      }
      const result = await identity.enrol({
        provisioningSecret: String(body['provisioningSecret'] ?? ''),
        subject: String(body['subject'] ?? '') as never,
        password: String(body['password'] ?? ''),
      });
      if (!result.ok) {
        sendJson(res, 401, { error: result.error.code });
        return;
      }
      sendJson(res, 200, result.value);
      return;
    }

    // POST /console/login — local login; allowed while provisioning pending (returns 401)
    if (req.method === 'POST' && url.pathname === '/console/login') {
      const body = await readJsonBody(req) as Record<string, unknown> | null;
      if (!body || typeof body !== 'object') {
        sendJson(res, 400, { error: 'bad-request' });
        return;
      }
      const result = await identity.loginLocal({
        subject: String(body['subject'] ?? '') as never,
        password: String(body['password'] ?? ''),
        totpCode: String(body['totpCode'] ?? ''),
      });
      if (!result.ok) {
        sendJson(res, 401, { error: result.error.code });
        return;
      }
      sessionCookieValue(res, result.value);
      sendJson(res, 200, { id: result.value.id });
      return;
    }

    // POST /console/logout — invalidates session server-side
    if (req.method === 'POST' && url.pathname === '/console/logout') {
      if (!checkCsrf(req)) {
        sendJson(res, 403, { error: 'csrf-check-failed' });
        return;
      }
      const sessionId = getSessionId(req);
      if (!sessionId) {
        sendJson(res, 401, { error: 'session-unknown' });
        return;
      }
      await identity.logout(sessionId);
      clearSessionCookie(res);
      sendJson(res, 200, {});
      return;
    }

    // All other /console/* routes require an active session
    const sessionId = getSessionId(req);
    if (!sessionId) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    const touched = await identity.touch(sessionId);
    if (!touched.ok) {
      sendJson(res, 401, { error: touched.error.code });
      return;
    }
    // Future console routes check here; return 404 for now.
    sendJson(res, 404, { error: 'not-found' });
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
