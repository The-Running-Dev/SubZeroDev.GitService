import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sha256Hex, type GitSha, type Sha256Hex } from '../shared/brands.ts';

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

export interface SurfacesDependencies {
  readonly commitSha: GitSha;
  readonly contractFingerprint: Sha256Hex;
  readonly consoleFingerprint: Sha256Hex;
  readonly ready: () => boolean;
  /**
   * A shared-secret bearer check standing in for the L4 Authorization module
   * (S13 onward), which this slice does not touch. Good enough to prove
   * "authenticated route, 401 without a credential" without building OAuth.
   */
  readonly operatorApiToken: string;
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

export function createSurfacesServer(deps: SurfacesDependencies): Server {
  return createServer((req, res) => {
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

    sendJson(res, 404, { error: 'not-found' });
  });
}
