import type { HttpOperationName, HttpsUrl, GitSha } from '../shared/brands.ts';
import type { CallContext } from '../shared/call-context.ts';
import type { JsonValue } from '../contract/json.ts';
import type { ToolLimits } from '../contract/tool-declaration.ts';
import { success, precondition, upstream, timeout as timeoutResult, infrastructure, type ToolResult } from '../result/envelope.ts';
import { diagnosticsFor } from '../shared/diagnostics.ts';
import type { Clock } from '../clock/clock.ts';

/**
 * `20-contract.md` § L3 — http adapter. Its one real consumer is
 * published-URL verification (`10-design.md` § "The http adapter's
 * consumer") — an unauthenticated HTTPS GET of a *managed repository's*
 * published URL, confirming a 200 and that the commit being served is the
 * expected merge commit. **No credential dependency, ever** (S12.7) — the
 * contract's L1-only dependency list for this module is load-bearing, not
 * incidental.
 */
export interface HttpAdapter {
  invoke(operation: HttpOperationName, ctx: CallContext, input: JsonValue, limits: ToolLimits): Promise<ToolResult<JsonValue>>;
  declaredOperations(): ReadonlySet<HttpOperationName>;
}

export const VERIFY_PUBLISHED_URL_OPERATION = 'verify-published-url' as HttpOperationName;

interface VerifyPublishedUrlInput {
  readonly url: HttpsUrl;
  readonly expectedCommitSha: GitSha;
}

interface VerifyPublishedUrlData {
  readonly url: HttpsUrl;
  readonly commitSha: GitSha;
}

export interface HttpAdapterDependencies {
  readonly clock: Clock;
  /** Injectable so a test can substitute a fixture without a real network call. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

function isVerifyPublishedUrlInput(value: JsonValue): value is JsonValue & VerifyPublishedUrlInput {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).url === 'string' &&
    typeof (value as Record<string, unknown>).expectedCommitSha === 'string'
  );
}

/**
 * `10-design.md` § "The http adapter's consumer": "Its failure set is what
 * an unauthenticated GET can actually distinguish: unreachable or non-2xx, a
 * 200 serving a commit other than the expected one, and the declared
 * timeout." **This is not the same check as definition-of-done item 15** —
 * that companion script polls this service's own `/healthz`, and its four
 * classifications (`stale-runtime`, `mixed-runtime`, ...) are not reachable
 * from an unauthenticated GET of somebody else's site.
 *
 * The convention this adapter reads is the one convention the design
 * actually establishes anywhere for "a commit a published site is serving":
 * this service's own `/healthz` reports `{ ready, commitSha }` as JSON
 * (`surfaces/http-server.ts`). A managed repository's published URL is
 * expected to answer the same shape at the URL declared for verification —
 * a lower-bound decision recorded in `90-decisions.md`, the same way every
 * other slice's U1 resolution is.
 */
export function createHttpAdapter(deps: HttpAdapterDependencies): HttpAdapter {
  const { clock } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const declared = new Set<HttpOperationName>([VERIFY_PUBLISHED_URL_OPERATION]);

  async function verifyPublishedUrl(ctx: CallContext, input: JsonValue, limits: ToolLimits): Promise<ToolResult<JsonValue>> {
    const startedAtMs = Date.now();
    if (!isVerifyPublishedUrlInput(input)) {
      return infrastructure(`'${VERIFY_PUBLISHED_URL_OPERATION}' received an input its own schema should have rejected`);
    }
    const { url, expectedCommitSha } = input;

    // An already-aborted signal never fires 'abort' again, so the listener
    // below would miss it and the GET would run uncancellable — the same
    // pre-start guard `Exec.runGit` applies before spawning a child.
    if (ctx.signal.aborted) {
      return infrastructure(`GET ${url} was cancelled before it started`);
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    ctx.signal.addEventListener('abort', onAbort);
    const timer = setTimeout(() => controller.abort(), limits.timeoutSeconds * 1000);

    let response: Response;
    try {
      response = await fetchImpl(url as string, { method: 'GET', signal: controller.signal });
    } catch (cause) {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      if (controller.signal.aborted && !ctx.signal.aborted) {
        return timeoutResult(`GET ${url} did not respond within ${limits.timeoutSeconds}s`, limits.timeoutSeconds);
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      return upstream(`${url} could not be reached: ${message}`, null);
    }
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onAbort);

    if (response.status < 200 || response.status >= 300) {
      return upstream(`GET ${url} returned ${response.status}`, null);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return upstream(`${url} served a 200 with no readable commit information`, null);
    }
    const servedCommitSha =
      body !== null && typeof body === 'object' && typeof (body as Record<string, unknown>).commitSha === 'string'
        ? ((body as Record<string, unknown>).commitSha as string)
        : null;
    if (servedCommitSha === null) {
      return upstream(`${url} served a 200 with no readable commit information`, null);
    }

    if (servedCommitSha !== (expectedCommitSha as string)) {
      return precondition(`${url} serves commit ${servedCommitSha}, not the expected ${expectedCommitSha}`, [
        { path: 'expectedCommitSha', rule: 'must-match-served', message: expectedCommitSha as string },
        { path: 'commitSha', rule: 'must-match-served', message: servedCommitSha },
      ]);
    }

    const data: VerifyPublishedUrlData = { url, commitSha: servedCommitSha as GitSha };
    return success(`${url} is serving the expected commit ${servedCommitSha}`, data as unknown as JsonValue, diagnosticsFor(ctx, startedAtMs, clock));
  }

  return {
    async invoke(operation, ctx, input, limits): Promise<ToolResult<JsonValue>> {
      if (operation !== VERIFY_PUBLISHED_URL_OPERATION) {
        return infrastructure(`no http operation registered for '${operation}'`);
      }
      return verifyPublishedUrl(ctx, input, limits);
    },
    declaredOperations(): ReadonlySet<HttpOperationName> {
      return declared;
    },
  };
}
