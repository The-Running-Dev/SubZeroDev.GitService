import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sha256Hex, type BearerToken, type GitSha, type Sha256Hex } from '../shared/brands.ts';
import type { AuditChainState } from '../audit/types.ts';
import type { CredentialFailureMark } from '../credentials/types.ts';
import type { CredentialRef, DeclarationId, OperationId } from '../shared/brands.ts';
import type { ActorRef } from '../shared/actor.ts';
import type { Session } from '../shared/session.ts';
import type { CapabilityName } from '../contract/capabilities.ts';
import type { Authorization } from '../authorization/authorization.ts';
import type { ObservedGitState, PreState } from '../clone/types.ts';
import type { OperationJournalEntry } from '../journal/types.ts';
import { NO_VOLUME_USAGE, type VolumeUsage } from '../store/volume-usage.ts';
import { handleConsoleAuthRoute, type ConsoleAuthDependencies } from './console-auth-routes.ts';
import { handleDeclarationRoute, type DeclarationRoutesDependencies } from './declaration-routes.ts';
import { handleToolRoute, type ToolRoutesDependencies } from './tool-routes.ts';
import { handleAuthorizationRoute, type AuthorizationRoutesDependencies } from './authorization-routes.ts';
import { handleMcpRoute, type McpRoutesDependencies } from './mcp-routes.ts';

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
 * `auditChain` is real as of S3, `failingCredentialRefs` as of S9,
 * `parkedOperations` as of S8, and `failedOutboxRows` as of S11; `volume` is
 * genuinely zero until S17's volume accounting exists — not a placeholder
 * standing in for unmeasured data, but a true statement that nothing has
 * happened yet in a subsystem that does not run.
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

export interface SurfacesDependencies
  extends ConsoleAuthDependencies,
    AuthorizationRoutesDependencies,
    Pick<DeclarationRoutesDependencies, 'declarations' | 'cloneStore' | 'declarationsAwaitingRecovery'>,
    Pick<ToolRoutesDependencies, 'dispatchPipeline' | 'contractCapabilitySet'>,
    Pick<McpRoutesDependencies, 'mcpState' | 'origin'> {
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
   * The parked-operations view (S8). Live for the same reason
   * `provisioningPending` is: recovery parks and a repair session unparks
   * without a restart, so a boot-time count would be wrong within minutes.
   * Optional so a surfaces server assembled without a journal still reports
   * an honest zero rather than failing to construct.
   */
  readonly parkedOperations?: () => Promise<readonly OperationJournalEntry[]>;
  /**
   * The observed current state of a declaration's clone, for the parked view's
   * `preState` / observed / diff comparison (`10-design.md` § operator-only
   * views, item 6). `null` when it cannot be observed — a corrupt or absent
   * tree is exactly the case a parked entry is most likely to be sitting on,
   * and the view has to render it rather than fail.
   */
  readonly observeGitState?: (declarationId: DeclarationId) => Promise<ObservedGitState | null>;
  /**
   * The parked view's way out (`10-design.md` § operator-only views, item 7).
   * Settles the entry and returns the clone to `ready`; the alternative
   * resolution, keeping it parked, is simply not calling this.
   */
  readonly resolveParkedOperation?: (operationId: OperationId, actor: ActorRef) => Promise<{ readonly ok: boolean; readonly summary: string }>;
  /**
   * Failing credential references, and the by-hand way to clear one (S9). The
   * design gives a mark two ways out — the resolver observing a changed
   * secret, and the operator clearing it from the health view — and this is
   * the second. Optional so a surfaces server assembled without a resolver
   * still reports an honest empty list.
   */
  readonly failingCredentialRefs?: () => Promise<readonly CredentialFailureMark[]>;
  readonly clearFailingCredential?: (ref: CredentialRef, declarationId: DeclarationId) => Promise<void>;
  /**
   * The count behind `failedOutboxRows` (S11). Optional so a surfaces server
   * assembled without a notifier still reports an honest zero rather than
   * failing to construct — the same shape as `failingCredentialRefs` above.
   */
  readonly failedOutboxRows?: () => Promise<number>;
}

/** The three fields `10-design.md` requires of each row in the parked view. */
function stateComparison(preState: PreState, observed: ObservedGitState | null): Record<string, unknown> {
  const fields = ['branch', 'headSha', 'upstreamSha', 'indexDigest', 'worktreeDigest'] as const;
  return {
    preState,
    observed,
    // The diff is computed here rather than left to the reader: "which of the
    // five fields moved" is the whole question an operator is asking, and
    // making them compare two digest strings by eye is how a repair gets done
    // against the wrong repository.
    diff:
      observed === null
        ? null
        : fields
            .filter((field) => preState[field] !== observed[field])
            .map((field) => ({ field, before: preState[field], after: observed[field] })),
  };
}

/**
 * `null` with the response already sent, mirroring `console-auth-routes.ts`'s
 * `requireSession`. `null` for a missing or malformed header, and for a
 * cookie presented instead of a bearer — a bearer route reads only
 * `Authorization`, never `Cookie`, so a cookie alone can never authenticate
 * one (S13.2's "bearer routes reject a cookie" half; the other half,
 * `requireSession` itself, reads only `Cookie`).
 *
 * Three distinct answers, because collapsing them misdirects the operator:
 * `401` the credential is not good, `403` it is good but its scopes do not
 * reach this route, `503` the store could not answer — the last is what
 * `authorization/errors.ts` fixes for `store-failed`, and reporting it as
 * `401` sends an operator hunting a revoked token instead of a sick volume.
 *
 * `required` is `null` on the two mutating routes: the capabilities that
 * would gate them (`attention.resolve`, `declaration.manage`) are
 * console-only, so no operator-api token can ever carry one and a gate here
 * would simply delete the route. The full route-to-capability mapping is
 * `20-contract.md` § U4's to settle.
 */
async function requireBearerSession(
  deps: Pick<SurfacesDependencies, 'authorization'>,
  req: IncomingMessage,
  res: ServerResponse,
  required: CapabilityName | null,
): Promise<Session | null> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    sendJson(res, 401, { error: 'unauthorized' });
    return null;
  }
  const verified = await deps.authorization.verifyOperatorApiToken(header.slice('Bearer '.length) as BearerToken);
  if (!verified.ok) {
    if (verified.error.code === 'store-failed') {
      sendJson(res, 503, { error: verified.error.code, summary: verified.error.summary });
      return null;
    }
    sendJson(res, 401, { error: 'unauthorized' });
    return null;
  }
  if (required !== null && !(verified.value.grant as unknown as ReadonlySet<CapabilityName>).has(required)) {
    sendJson(res, 403, { error: 'forbidden', summary: `this token's scopes do not carry '${required}'` });
    return null;
  }
  return verified.value;
}

function resolverActorFor(session: Session): ActorRef {
  return session.actorRef;
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

  if (url.pathname.startsWith('/declarations')) {
    // More specific first: `/declarations/:id/tools*` is its own route
    // family, and `handleDeclarationRoute` would otherwise 404 it itself
    // before this ever got a chance to look.
    const toolsHandled = await handleToolRoute(deps, req, res, url);
    if (toolsHandled) return;
    const handled = await handleDeclarationRoute(deps, req, res, url);
    if (handled) return;
  }

  if (
    url.pathname === '/grants' ||
    url.pathname === '/grants/tokens' ||
    /^\/grants\/[^/]+\/revoke$/.test(url.pathname) ||
    /^\/tokens\/[^/]+\/revoke$/.test(url.pathname) ||
    /^\/clients\/[^/]+\/revoke$/.test(url.pathname) ||
    /^\/operator-sessions\/[^/]+\/revoke$/.test(url.pathname)
  ) {
    const handled = await handleAuthorizationRoute(deps, req, res, url);
    if (handled) return;
  }

  if (
    url.pathname.startsWith('/mcp/') ||
    url.pathname.startsWith('/oauth/') ||
    url.pathname.startsWith('/.well-known/oauth-')
  ) {
    const handled = await handleMcpRoute(deps, req, res, url);
    if (handled) return;
  }

  if (req.method === 'GET' && url.pathname === '/healthz') {
    const report: LivenessReport = { ready: deps.ready(), commitSha: deps.commitSha };
    sendJson(res, 200, report);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/version') {
    if (!(await requireBearerSession(deps, req, res, 'repo.read'))) return;
    const report: VersionReport = {
      commitSha: deps.commitSha,
      contractFingerprint: deps.contractFingerprint,
      consoleFingerprint: deps.consoleFingerprint,
    };
    sendJson(res, 200, report);
    return;
  }

  // The parked-operations view. `/health` carries the count; this carries the
  // entries themselves, which is what makes the count actionable — an
  // operator can see which repository, which tool, and why, without host
  // access. Authenticated, like every route but `/healthz`: a parked
  // operation names a declaration and a tool, which is operator data.
  if (req.method === 'GET' && url.pathname === '/parked-operations') {
    if (!(await requireBearerSession(deps, req, res, 'repo.read'))) return;
    const parked = deps.parkedOperations ? await deps.parkedOperations() : [];
    const operations = [];
    for (const entry of parked) {
      const observed = deps.observeGitState ? await deps.observeGitState(entry.declarationId) : null;
      operations.push({
        operationId: entry.operationId,
        declarationId: entry.declarationId,
        generation: entry.generation,
        tool: entry.tool,
        reason: entry.attentionReason,
        startedAt: entry.startedAt,
        updatedAt: entry.updatedAt,
        ...stateComparison(entry.preState, observed),
      });
    }
    sendJson(res, 200, { operations });
    return;
  }

  // A failing credential's second way out. The first — replacing the secret in
  // the mount — needs no route at all, which is the point of resolving at
  // point of use; this is the one for a mark left by a fault that has since
  // been fixed somewhere other than the file.
  const clearCredentialMatch = /^\/failing-credentials\/([^/]+)\/([^/]+)\/clear$/.exec(url.pathname);
  if (req.method === 'POST' && clearCredentialMatch) {
    if (!(await requireBearerSession(deps, req, res, null))) return;
    if (!deps.clearFailingCredential) {
      sendJson(res, 503, { error: 'unavailable', summary: 'no credential resolver is wired into this server' });
      return;
    }
    const ref = decodeURIComponent(clearCredentialMatch[1]!) as CredentialRef;
    const declarationId = decodeURIComponent(clearCredentialMatch[2]!) as DeclarationId;
    await deps.clearFailingCredential(ref, declarationId);
    sendJson(res, 200, { cleared: true, ref, declarationId });
    return;
  }

  // The way out. A parked entry's other resolution — keeping it parked — is
  // not calling this, so there is deliberately no route for it.
  const resolveMatch = /^\/parked-operations\/([^/]+)\/resolve$/.exec(url.pathname);
  if (req.method === 'POST' && resolveMatch) {
    const session = await requireBearerSession(deps, req, res, null);
    if (!session) return;
    if (!deps.resolveParkedOperation) {
      sendJson(res, 503, { error: 'unavailable', summary: 'no journal is wired into this server' });
      return;
    }
    const resolved = await deps.resolveParkedOperation(resolveMatch[1] as OperationId, resolverActorFor(session));
    sendJson(res, resolved.ok ? 200 : 409, resolved.ok ? { resolved: true, summary: resolved.summary } : { error: 'not-resolved', summary: resolved.summary });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    if (!(await requireBearerSession(deps, req, res, 'repo.read'))) return;
    const auditChain = await deps.auditChain();
    const parked = deps.parkedOperations ? await deps.parkedOperations() : [];
    const report: HealthReport = {
      ready: deps.ready(),
      provisioningPending: await deps.provisioningPending(),
      version: { commitSha: deps.commitSha, contractFingerprint: deps.contractFingerprint, consoleFingerprint: deps.consoleFingerprint },
      auditChain,
      failedOutboxRows: deps.failedOutboxRows ? await deps.failedOutboxRows() : 0,
      failingCredentialRefs: deps.failingCredentialRefs ? await deps.failingCredentialRefs() : [],
      parkedOperations: parked.length,
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
