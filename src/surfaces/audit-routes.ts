import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Audit } from '../audit/audit.ts';
import type { AuditError } from '../audit/errors.ts';
import { declarationId, isoUtcTimestamp, type RegistryToolName, type Subject } from '../shared/brands.ts';
import { AUDIT_RECORD_FORMS, type AuditRecordForm } from '../audit/types.ts';
import { requireSession, type ConsoleAuthDependencies } from './console-auth-routes.ts';

export interface AuditRoutesDependencies extends ConsoleAuthDependencies {
  readonly audit: Audit;
}

const RECORD_FORMS: readonly AuditRecordForm[] = AUDIT_RECORD_FORMS;

const CURSOR_PATTERN = /^\d+$/;

function auditErrorStatus(error: AuditError): number {
  return error.resultKind === 'validation' ? 400 : 503;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

const DEFAULT_LIMIT = 200;

/**
 * `20-contract.md` § U4: `/audit` is a cookie route under `audit.read`.
 * `OperatorScope` names no instance-level capability (`20-contract.md` §
 * Scopes), so no operator-api bearer token can ever carry `audit.read` — this
 * route is reachable only through `requireSession`, which reads the console
 * session cookie and never `Authorization`, the same construction
 * `authorization-routes.ts` relies on for the grants view.
 */
export async function handleAuditRoute(deps: AuditRoutesDependencies, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method !== 'GET' || url.pathname !== '/audit') return false;

  const session = await requireSession(deps, req, res);
  if (!session) return true;

  const formParam = url.searchParams.get('form');
  if (formParam !== null && !RECORD_FORMS.includes(formParam as AuditRecordForm)) {
    sendJson(res, 400, { error: 'bad-request', summary: `form must be one of ${RECORD_FORMS.join(', ')}` });
    return true;
  }

  const declarationIdParam = url.searchParams.get('declarationId');
  const declarationIdResult = declarationIdParam !== null ? declarationId(declarationIdParam) : null;
  if (declarationIdResult && !declarationIdResult.ok) {
    sendJson(res, 400, { error: 'bad-request', summary: `declarationId: ${declarationIdResult.error.rule}` });
    return true;
  }

  const fromParam = url.searchParams.get('from');
  const fromResult = fromParam !== null ? isoUtcTimestamp(fromParam) : null;
  if (fromResult && !fromResult.ok) {
    sendJson(res, 400, { error: 'bad-request', summary: `from: ${fromResult.error.rule}` });
    return true;
  }

  const toParam = url.searchParams.get('to');
  const toResult = toParam !== null ? isoUtcTimestamp(toParam) : null;
  if (toResult && !toResult.ok) {
    sendJson(res, 400, { error: 'bad-request', summary: `to: ${toResult.error.rule}` });
    return true;
  }

  const cursorParam = url.searchParams.get('cursor');
  if (cursorParam !== null && !CURSOR_PATTERN.test(cursorParam)) {
    sendJson(res, 400, { error: 'bad-request', summary: 'cursor must be a non-negative integer' });
    return true;
  }

  const page = await deps.audit.query({
    declarationId: declarationIdResult && declarationIdResult.ok ? declarationIdResult.value : null,
    tool: url.searchParams.get('tool') as RegistryToolName | null,
    actorSubject: url.searchParams.get('actorSubject') as Subject | null,
    form: formParam as AuditRecordForm | null,
    from: fromResult && fromResult.ok ? fromResult.value : null,
    to: toResult && toResult.ok ? toResult.value : null,
    limit: DEFAULT_LIMIT,
    cursor: cursorParam,
  });

  if (!page.ok) {
    sendJson(res, auditErrorStatus(page.error), { error: page.error.code, summary: page.error.summary });
    return true;
  }

  sendJson(res, 200, page.value);
  return true;
}
