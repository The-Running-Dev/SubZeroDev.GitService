import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Audit } from '../audit/audit.ts';
import type { DeclarationId, IsoUtcTimestamp, RegistryToolName, Subject } from '../shared/brands.ts';
import type { AuditRecordForm } from '../audit/types.ts';
import { requireSession, type ConsoleAuthDependencies } from './console-auth-routes.ts';

export interface AuditRoutesDependencies extends ConsoleAuthDependencies {
  readonly audit: Audit;
}

const RECORD_FORMS: readonly AuditRecordForm[] = [
  'call',
  'authorization-rejection',
  'hatch-intent',
  'hatch-outcome',
  'file-watcher',
  'identity-event',
  'lease-takeover',
];

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

  const page = await deps.audit.query({
    declarationId: url.searchParams.get('declarationId') as DeclarationId | null,
    tool: url.searchParams.get('tool') as RegistryToolName | null,
    actorSubject: url.searchParams.get('actorSubject') as Subject | null,
    form: formParam as AuditRecordForm | null,
    from: url.searchParams.get('from') as IsoUtcTimestamp | null,
    to: url.searchParams.get('to') as IsoUtcTimestamp | null,
    limit: DEFAULT_LIMIT,
    cursor: url.searchParams.get('cursor'),
  });

  if (!page.ok) {
    sendJson(res, 503, { error: page.error.code, summary: page.error.summary });
    return true;
  }

  sendJson(res, 200, page.value);
  return true;
}
