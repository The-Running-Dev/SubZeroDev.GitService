import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { declarationId, type SessionId } from '../shared/brands.ts';
import type { Session } from '../shared/session.ts';
import type { ContractCapabilitySet } from '../contract/capabilities.ts';
import type { DispatchPipeline } from '../dispatch/dispatch-pipeline.ts';
import type { Declarations } from '../declarations/declarations.ts';
import type { OperatorSession } from '../operator-identity/operator-identity.ts';
import { csrfOk, requireSession, type ConsoleAuthDependencies } from './console-auth-routes.ts';
import { readJsonBody, sendJson } from './http-json.ts';

export interface ToolRoutesDependencies extends ConsoleAuthDependencies {
  readonly declarations: Pick<Declarations, 'get'>;
  readonly dispatchPipeline: DispatchPipeline;
  readonly contractCapabilitySet: ContractCapabilitySet;
}

const MAX_BODY_BYTES = 1_048_576;

/**
 * `20-contract.md` § Unresolved U4: the full HTTP route table is gated to
 * S18, and its own gate-table entry lists only S18 as blocked by it — not
 * S6. Following the precedent `90-decisions.md`'s 2026-08-04 entry sets for
 * S4's `/auth/*` routes: a small, self-contained namespace now rather than
 * leaving this slice's own acceptance criteria ("reachable over the HTTP
 * API") untestable, with U4 free to fold or rename these paths later.
 *
 * The operator console session is treated as carrying full authority here,
 * exactly as `declaration-routes.ts` already treats it for
 * `declaration.manage` — there is no durable grant model
 * (`Authorization`, S13) yet to compute a narrower one from.
 */
function sessionFor(operatorSession: OperatorSession, contractCapabilitySet: ContractCapabilitySet): Session {
  return {
    id: randomUUID() as SessionId,
    kind: 'operator',
    actorRef: { kind: 'operator', subject: operatorSession.subject, clientId: null, grantId: null },
    repositoryBinding: null,
    grant: contractCapabilitySet as unknown as Session['grant'],
    frozenAtEpoch: 0 as unknown as Session['frozenAtEpoch'],
  };
}

function toolResultStatus(kind: string): number {
  if (kind === 'success') return 200;
  if (kind === 'validation' || kind === 'precondition') return 400;
  if (kind === 'authorization') return 403;
  if (kind === 'conflict') return 409;
  if (kind === 'timeout') return 504;
  if (kind === 'upstream') return 502;
  return 500;
}

export async function handleToolRoute(deps: ToolRoutesDependencies, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  // ['declarations', id, 'tools'] | ['declarations', id, 'tools', toolName]
  if (segments[0] !== 'declarations' || segments[2] !== 'tools') return false;

  const session = await requireSession(deps, req, res);
  if (!session) return true;

  const idResult = segments[1] !== undefined ? declarationId(segments[1]) : null;
  if (!idResult || !idResult.ok) {
    sendJson(res, 400, { error: 'validation', findings: ['id: ' + (idResult?.error.rule ?? 'must be present')] });
    return true;
  }

  const declaration = await deps.declarations.get(idResult.value);
  const toolSession = sessionFor(session, deps.contractCapabilitySet);

  if (req.method === 'GET' && segments.length === 3) {
    const tools = deps.dispatchPipeline.visibleTools(toolSession, declaration);
    sendJson(res, 200, { tools: tools.map((t) => ({ name: t.name, description: t.description, executionClass: t.executionClass })) });
    return true;
  }

  if (req.method === 'POST' && segments.length === 4) {
    if (!csrfOk(req)) {
      sendJson(res, 403, { error: 'csrf-check-failed' });
      return true;
    }
    const toolName = segments[3];
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (body === null) {
      sendJson(res, 400, { error: 'bad-request' });
      return true;
    }
    const controller = new AbortController();
    const result = await deps.dispatchPipeline.dispatch({
      toolName: toolName as never,
      input: body as never,
      session: toolSession,
      declarationId: idResult.value,
      scheduledJobId: null,
      context: 'normal',
      signal: controller.signal,
    });
    sendJson(res, toolResultStatus(result.kind), result);
    return true;
  }

  sendJson(res, 404, { error: 'not-found' });
  return true;
}
