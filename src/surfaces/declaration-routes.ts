import type { IncomingMessage, ServerResponse } from 'node:http';
import { declarationId, pathPrefix, credentialRef, type DeclarationId, type RegistryToolName } from '../shared/brands.ts';
import type { ActorRef } from '../shared/actor.ts';
import type { DeclarationScopedCapability, HostKind } from '../contract/capabilities.ts';
import type { Declarations } from '../declarations/declarations.ts';
import type { DeclarationError } from '../declarations/errors.ts';
import type { AmendInput, DeclareInput } from '../declarations/types.ts';
import type { CloneStore } from '../clone/clone-store.ts';
import type { CloneStoreError } from '../clone/errors.ts';
import type { Clone } from '../clone/types.ts';
import type { OperatorSession } from '../operator-identity/operator-identity.ts';
import { csrfOk, requireSession, type ConsoleAuthDependencies } from './console-auth-routes.ts';

export interface DeclarationRoutesDependencies extends ConsoleAuthDependencies {
  readonly declarations: Declarations;
  readonly cloneStore: CloneStore;
  /**
   * Declarations holding at least one unsettled journal entry (S8).
   *
   * `recovery-pending` is derived rather than stored — no `CloneStore` method
   * writes it (`design/90-decisions.md`, 2026-08-08) — so it has to be
   * overlaid here, on the way out. Without this the state would exist in the
   * contract's `CloneState` union and in `BootReport` and be observable
   * nowhere, which is the same as not existing.
   */
  readonly declarationsAwaitingRecovery?: () => Promise<ReadonlySet<string>>;
}

/**
 * The clone as an operator should see it: `recovery-pending` outranks the
 * stored state, because a clone that reads `ready` while an unsettled entry
 * is outstanding is telling the operator the repository is available for
 * work the dispatch pipeline will in fact refuse.
 */
function withRecoveryOverlay(clone: Clone | null, awaiting: ReadonlySet<string>): Clone | null {
  if (!clone || !awaiting.has(clone.declarationId)) return clone;
  if (clone.state === 'needs-attention') return clone;
  return { ...clone, state: 'recovery-pending' };
}

/** Every mutating route here is a cookie route, so it gets invariant E7 in full — session first (401), then origin + double-submit token (403), same order and shapes `console-auth-routes.ts` uses. */
function requireCsrf(req: IncomingMessage, res: ServerResponse): boolean {
  if (csrfOk(req)) return true;
  res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'csrf-check-failed' }));
  return false;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function declarationErrorStatus(error: DeclarationError): number {
  if (error.resultKind === 'infrastructure') return 503;
  if (error.resultKind === 'validation') return 400;
  return error.code === 'not-found' ? 404 : 409;
}

function sendDeclarationError(res: ServerResponse, error: DeclarationError): void {
  sendJson(res, declarationErrorStatus(error), { error: error.code, ...error });
}

function cloneStoreErrorStatus(error: CloneStoreError): number {
  if (error.resultKind === 'infrastructure') return 503;
  if (error.resultKind === 'timeout') return 504;
  if (error.resultKind === 'upstream') return 502;
  return 409;
}

function sendCloneStoreError(res: ServerResponse, error: CloneStoreError): void {
  sendJson(res, cloneStoreErrorStatus(error), { error: error.code, ...error });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    bytes += buf.length;
    if (bytes > 65_536) return null;
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function actorFor(session: OperatorSession): ActorRef {
  return { kind: 'operator', subject: session.subject, clientId: null, grantId: null };
}

/**
 * Raw-string-to-brand parsing lives here, at the HTTP boundary — the same
 * place `declarationId()` and friends are meant to be reached from
 * (`20-contract.md` § Identifiers and constrained strings). By the time
 * `Declarations.declare` sees a `DeclareInput`, its fields are already valid
 * brands; this is what makes the S5 acceptance criterion ("declaring with an
 * id violating the pattern returns `validation`") true without `declare()`
 * re-parsing raw strings itself.
 */
function validateFileWatcherShape(raw: unknown): { readonly planTool: RegistryToolName; readonly applyTool: RegistryToolName; readonly autoMerge: boolean } | null {
  const watcher = raw as { readonly planTool?: unknown; readonly applyTool?: unknown; readonly autoMerge?: unknown };
  if (typeof watcher?.planTool !== 'string' || typeof watcher.applyTool !== 'string' || typeof watcher.autoMerge !== 'boolean') return null;
  return { planTool: watcher.planTool as RegistryToolName, applyTool: watcher.applyTool as RegistryToolName, autoMerge: watcher.autoMerge };
}

export function parseDeclareInput(body: Record<string, unknown>): { readonly ok: true; readonly value: DeclareInput } | { readonly ok: false; readonly findings: readonly string[] } {
  const findings: string[] = [];

  const idResult = typeof body.id === 'string' ? declarationId(body.id) : null;
  if (!idResult || !idResult.ok) findings.push(`id: ${typeof body.id === 'string' ? idResult?.error.rule : 'must be a string'}`);

  const host: HostKind | null = body.host === 'github' || body.host === 'generic' ? body.host : null;
  if (host === null) findings.push('host: must be "github" or "generic"');

  const rawCloneUrl = typeof body.cloneUrl === 'string' ? body.cloneUrl : null;
  if (rawCloneUrl === null) findings.push('cloneUrl: must be a string');

  const credentialResult = typeof body.credentialRef === 'string' ? credentialRef(body.credentialRef) : null;
  if (!credentialResult || !credentialResult.ok) findings.push(`credentialRef: ${typeof body.credentialRef === 'string' ? credentialResult?.error.rule : 'must be a string'}`);

  const rawGrant = Array.isArray(body.capabilityGrant) ? body.capabilityGrant : [];
  if (!rawGrant.every((c) => typeof c === 'string')) findings.push('capabilityGrant: every entry must be a string');

  const rawPrefixes = Array.isArray(body.writablePathPrefixes) ? body.writablePathPrefixes : [];
  const prefixResults = rawPrefixes.map((p) => (typeof p === 'string' ? pathPrefix(p) : null));
  if (prefixResults.some((r) => !r || !r.ok)) findings.push('writablePathPrefixes: every entry must be a valid path prefix');

  const identity = body.identity as { readonly gitUserName?: unknown; readonly gitUserEmail?: unknown } | undefined;
  const gitUserName = typeof identity?.gitUserName === 'string' ? identity.gitUserName : null;
  const gitUserEmail = typeof identity?.gitUserEmail === 'string' ? identity.gitUserEmail : null;
  if (gitUserName === null || gitUserEmail === null) findings.push('identity: gitUserName and gitUserEmail must be strings');

  let fileWatcher: DeclareInput['fileWatcher'] = null;
  if (body.fileWatcher !== null && body.fileWatcher !== undefined) {
    const validated = validateFileWatcherShape(body.fileWatcher);
    if (!validated) {
      findings.push('fileWatcher: planTool and applyTool must be strings and autoMerge must be boolean');
    } else {
      fileWatcher = validated;
    }
  }

  if (findings.length > 0 || !idResult?.ok || !credentialResult?.ok || rawCloneUrl === null || host === null || gitUserName === null || gitUserEmail === null) {
    return { ok: false, findings };
  }

  // `cloneUrl`'s own host-allowlist check happens inside `declare()` too
  // (`remote-host-not-allowed` is the "second, independent guard" the
  // contract names) — here it is only well-formedness, so a value naming a
  // host that fails the allowlist still reaches `declare()` to be rejected
  // there with the right, structured error rather than a generic 400.

  return {
    ok: true,
    value: {
      id: idResult.value,
      cloneUrl: rawCloneUrl as DeclareInput['cloneUrl'],
      host,
      credentialRef: credentialResult.value,
      capabilityGrant: rawGrant as readonly DeclarationScopedCapability[],
      writablePathPrefixes: prefixResults.map((r) => (r as { readonly ok: true; readonly value: DeclareInput['writablePathPrefixes'][number] }).value),
      pinned: body.pinned === true,
      fileWatcher,
      identity: { gitUserName, gitUserEmail },
    },
  };
}

export function toAmendInput(body: Record<string, unknown>): { readonly ok: true; readonly value: AmendInput } | { readonly ok: false; readonly findings: readonly string[] } {
  const rawGrant = Array.isArray(body.capabilityGrant) ? (body.capabilityGrant as readonly DeclarationScopedCapability[]) : null;
  const rawPrefixes = Array.isArray(body.writablePathPrefixes) ? (body.writablePathPrefixes as string[]).map((p) => pathPrefix(p)).filter((r) => r.ok).map((r) => r.value) : null;
  const identity = body.identity as { readonly gitUserName?: unknown; readonly gitUserEmail?: unknown } | undefined;

  const credentialRefResult = typeof body.credentialRef === 'string' ? credentialRef(body.credentialRef) : null;

  // Three-valued per `20-contract.md` § Declaration: omitted leaves it alone,
  // `null` removes it, and a complete object sets it. The declaration module
  // then validates both names against the runtime registry.
  const fileWatcherRaw = body.fileWatcher;
  let fileWatcher: AmendInput['fileWatcher'] = undefined;
  if ('fileWatcher' in body) {
    if (fileWatcherRaw === null) {
      fileWatcher = null;
    } else {
      const validated = validateFileWatcherShape(fileWatcherRaw);
      if (!validated) {
        return { ok: false, findings: ['fileWatcher: planTool and applyTool must be strings and autoMerge must be boolean'] };
      }
      fileWatcher = validated;
    }
  }

  return {
    ok: true,
    value: {
      cloneUrl: typeof body.cloneUrl === 'string' ? (body.cloneUrl as AmendInput['cloneUrl']) : null,
      credentialRef: credentialRefResult?.ok ? credentialRefResult.value : null,
      capabilityGrant: rawGrant,
      writablePathPrefixes: rawPrefixes,
      pinned: typeof body.pinned === 'boolean' ? body.pinned : null,
      fileWatcher,
      identity: typeof identity?.gitUserName === 'string' && typeof identity?.gitUserEmail === 'string' ? { gitUserName: identity.gitUserName, gitUserEmail: identity.gitUserEmail } : null,
    },
  };
}

/**
 * Console-session-authenticated declaration management, plus the landing
 * view's data feed — `30-slices.md` § S5's "declaration routes and the
 * landing view". No console frontend exists yet (S19 publishes one); this is
 * the JSON surface a landing view consumes, in the same shape every other
 * surface in this codebase currently ships (`console-auth-routes.ts`).
 *
 * Every route here requires `declaration.manage`. Nothing distinguishes that
 * from "has a valid operator session" yet — the operator session *is* the
 * only holder of every instance-scoped capability until S13 builds durable
 * grants (`10-design.md` § "Console authority is reachable... with
 * `declaration.manage`, `auth.manage`, `audit.read` and `attention.resolve`").
 */
export async function handleDeclarationRoute(
  deps: DeclarationRoutesDependencies,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (!url.pathname.startsWith('/declarations')) return false;

  const session = await requireSession(deps, req, res);
  if (!session) return true;

  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  // ['declarations'] | ['declarations', id] | ['declarations', id, 'orphan'] | ['declarations', id, 'clone']

  if (req.method === 'GET' && segments.length === 1) {
    const declarations = await deps.declarations.list({ state: null, hasFileWatcher: null });
    const awaiting = deps.declarationsAwaitingRecovery ? await deps.declarationsAwaitingRecovery() : new Set<string>();
    const withClones = await Promise.all(
      declarations.map(async (d) => ({ declaration: d, clone: await deps.cloneStore.describe(d.id) })),
    );
    sendJson(
      res,
      200,
      withClones.map(({ declaration, clone }) => ({ declaration, clone: withRecoveryOverlay(clone.ok ? clone.value : null, awaiting) })),
    );
    return true;
  }

  if (req.method === 'POST' && segments.length === 1) {
    if (!requireCsrf(req, res)) return true;
    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { error: 'bad-request' });
      return true;
    }
    const parsed = parseDeclareInput(body);
    if (!parsed.ok) {
      sendJson(res, 400, { error: 'validation', findings: parsed.findings });
      return true;
    }
    const result = await deps.declarations.declare(parsed.value, actorFor(session));
    if (!result.ok) {
      sendDeclarationError(res, result.error);
      return true;
    }
    sendJson(res, 201, result.value);
    return true;
  }

  const rawId = segments[1];
  const idResult = rawId !== undefined ? declarationId(rawId) : null;
  if (!idResult || !idResult.ok) {
    sendJson(res, 400, { error: 'validation', findings: ['id: ' + (idResult?.error.rule ?? 'must be present')] });
    return true;
  }
  const id: DeclarationId = idResult.value;

  if (req.method === 'GET' && segments.length === 2) {
    const declaration = await deps.declarations.get(id);
    if (!declaration) {
      sendJson(res, 404, { error: 'not-found' });
      return true;
    }
    const clone = await deps.cloneStore.describe(id);
    const awaiting = deps.declarationsAwaitingRecovery ? await deps.declarationsAwaitingRecovery() : new Set<string>();
    sendJson(res, 200, { declaration, clone: withRecoveryOverlay(clone.ok ? clone.value : null, awaiting) });
    return true;
  }

  if (req.method === 'PATCH' && segments.length === 2) {
    if (!requireCsrf(req, res)) return true;
    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { error: 'bad-request' });
      return true;
    }
    const parsed = toAmendInput(body);
    if (!parsed.ok) {
      sendJson(res, 400, { error: 'validation', findings: parsed.findings });
      return true;
    }
    const result = await deps.declarations.amend(id, parsed.value, actorFor(session));
    if (!result.ok) {
      sendDeclarationError(res, result.error);
      return true;
    }
    sendJson(res, 200, result.value);
    return true;
  }

  if (req.method === 'DELETE' && segments.length === 2) {
    if (!requireCsrf(req, res)) return true;
    const result = await deps.declarations.remove(id, actorFor(session));
    if (!result.ok) {
      sendDeclarationError(res, result.error);
      return true;
    }
    sendJson(res, 200, { removed: true });
    return true;
  }

  if (req.method === 'POST' && segments.length === 3 && segments[2] === 'orphan') {
    if (!requireCsrf(req, res)) return true;
    const result = await deps.declarations.orphan(id, actorFor(session));
    if (!result.ok) {
      sendDeclarationError(res, result.error);
      return true;
    }
    sendJson(res, 200, result.value);
    return true;
  }

  if (req.method === 'DELETE' && segments.length === 3 && segments[2] === 'clone') {
    if (!requireCsrf(req, res)) return true;
    const body = await readJsonBody(req);
    const permitCorruptTree = body !== null && body.permitCorruptTree === true;
    const result = await deps.cloneStore.remove(id, { permitCorruptTree }, actorFor(session));
    if (!result.ok) {
      sendCloneStoreError(res, result.error);
      return true;
    }
    sendJson(res, 200, { removed: true });
    return true;
  }

  sendJson(res, 404, { error: 'not-found' });
  return true;
}
