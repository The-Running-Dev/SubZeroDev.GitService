import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Definition-of-done item 15's companion script (`00-brief.md`, `10-design.md`
 * § *Published-URL verification is that consumer*, `30-slices.md` § S22.1).
 * Verifies *this service's own* deployment: polls `/healthz` until the
 * commit SHA is stable, then runs a real authenticated
 * `initialize → tools/list → tools/call` session against it. This is an
 * executable check shipped alongside the service, never a registry tool —
 * `scripts/build-registry.ts` never sees this file, which is the assertion
 * `verify-deployment.test.ts` makes for S22.1's "asserted by its absence
 * from the registry".
 *
 * The five classifications below are the brief's own list, in the brief's
 * own order: "Stale or mixed runtime, wrong catalogue, verification
 * credential rejected" maps onto `stale-runtime`, `mixed-runtime`,
 * `unexpected-profile-or-catalog`, `verification-credential` — reordered
 * here to match the sequence the check actually walks: readiness first,
 * then the session, then the credential inside it, then the catalogue the
 * credential's grant produces.
 */

export interface LivenessBody {
  readonly ready: boolean;
  readonly commitSha: string;
}

export type DeploymentClassification =
  | { readonly kind: 'stale-runtime'; readonly expectedCommit: string; readonly observedCommit: string }
  | { readonly kind: 'mixed-runtime'; readonly observedCommits: readonly string[] }
  | { readonly kind: 'verification-credential'; readonly detail: string }
  | { readonly kind: 'unexpected-profile-or-catalog'; readonly detail: string }
  | { readonly kind: 'verified'; readonly commitSha: string };

export interface VerifyDeploymentOptions {
  readonly baseUrl: string;
  readonly declarationId: string;
  readonly expectedCommitSha: string;
  readonly bearerToken: string;
  /** The tool the session must both see in `tools/list` and be able to call. Defaults to `repo_status`, per S22.1's own sequence. */
  readonly expectedTool?: string;
  readonly pollIntervalMs?: number;
  readonly pollTimeoutMs?: number;
  /** Consecutive identical `/healthz` reads required before the commit SHA counts as stable. */
  readonly stableReadCount?: number;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULTS = {
  expectedTool: 'repo_status',
  pollIntervalMs: 2_000,
  pollTimeoutMs: 120_000,
  stableReadCount: 3,
} as const;

/**
 * Polls `/healthz` until the same `commitSha` is read `stableReadCount`
 * times in a row, or `pollTimeoutMs` elapses. A fleet behind one hostname
 * that has not finished a rolling deploy answers with more than one commit
 * across the polling window and never stabilises — that is `mixed-runtime`,
 * distinguished here from `stale-runtime`, where every read agrees on one
 * commit that just is not the expected one.
 */
async function pollUntilStable(
  baseUrl: string,
  pollIntervalMs: number,
  pollTimeoutMs: number,
  stableReadCount: number,
  fetchImpl: typeof fetch,
): Promise<{ readonly stableCommit: string } | { readonly observedCommits: readonly string[] }> {
  const seen = new Set<string>();
  let lastCommit: string | null = null;
  let consecutive = 0;
  const deadline = Date.now() + pollTimeoutMs;

  for (;;) {
    const response = await fetchImpl(`${baseUrl}/healthz`);
    if (!response.ok) {
      throw new Error(`GET /healthz returned ${response.status} — the target is not reachable enough to classify`);
    }
    const body = (await response.json()) as LivenessBody;
    seen.add(body.commitSha);

    if (body.commitSha === lastCommit) {
      consecutive += 1;
    } else {
      lastCommit = body.commitSha;
      consecutive = 1;
    }
    if (consecutive >= stableReadCount) {
      return { stableCommit: body.commitSha };
    }
    if (Date.now() >= deadline) {
      return { observedCommits: [...seen] };
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

interface McpInitializeResult {
  readonly status: number;
  readonly sessionId: string | null;
  readonly body: Record<string, unknown>;
}

async function mcpInitialize(baseUrl: string, declarationId: string, bearerToken: string, fetchImpl: typeof fetch): Promise<McpInitializeResult> {
  const response = await fetchImpl(`${baseUrl}/mcp/${declarationId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  return {
    status: response.status,
    sessionId: response.headers.get('Mcp-Session-Id'),
    body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

async function mcpCall(baseUrl: string, declarationId: string, sessionId: string, method: string, params: unknown, fetchImpl: typeof fetch): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await fetchImpl(`${baseUrl}/mcp/${declarationId}`, {
    method: 'POST',
    headers: { 'Mcp-Session-Id': sessionId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }),
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

/**
 * S22.1: the whole check, end to end. Returns a classification rather than
 * throwing for any of the five named outcomes; still throws for a target
 * that is not reachable enough to classify at all (a connection failure,
 * or `/healthz` itself never answering), because that is not one of the
 * five failure modes this check exists to distinguish — it is the check
 * being unable to run, not a verdict about the deployment.
 */
export async function verifyDeployment(options: VerifyDeploymentOptions): Promise<DeploymentClassification> {
  const expectedTool = options.expectedTool ?? DEFAULTS.expectedTool;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
  const pollTimeoutMs = options.pollTimeoutMs ?? DEFAULTS.pollTimeoutMs;
  const stableReadCount = options.stableReadCount ?? DEFAULTS.stableReadCount;
  const fetchImpl = options.fetchImpl ?? fetch;

  const stability = await pollUntilStable(options.baseUrl, pollIntervalMs, pollTimeoutMs, stableReadCount, fetchImpl);
  if ('observedCommits' in stability) {
    return { kind: 'mixed-runtime', observedCommits: stability.observedCommits };
  }
  if (stability.stableCommit !== options.expectedCommitSha) {
    return { kind: 'stale-runtime', expectedCommit: options.expectedCommitSha, observedCommit: stability.stableCommit };
  }

  const init = await mcpInitialize(options.baseUrl, options.declarationId, options.bearerToken, fetchImpl);
  if (init.status === 401) {
    const detail = typeof init.body.error === 'object' && init.body.error !== null && 'message' in init.body.error ? String((init.body.error as { message: unknown }).message) : `initialize rejected with 401`;
    return { kind: 'verification-credential', detail };
  }
  if (init.status !== 200 || !init.sessionId) {
    throw new Error(`initialize returned ${init.status} with no session — the target is not reachable enough to classify`);
  }

  const list = await mcpCall(options.baseUrl, options.declarationId, init.sessionId, 'tools/list', {}, fetchImpl);
  const tools = (list.body.result as { tools?: readonly { name?: string }[] } | undefined)?.tools ?? [];
  const toolNames = tools.map((t) => t.name).filter((n): n is string => typeof n === 'string');
  if (!toolNames.includes(expectedTool)) {
    return { kind: 'unexpected-profile-or-catalog', detail: `'${expectedTool}' is absent from tools/list; catalogue carries: ${toolNames.join(', ') || '(none)'}` };
  }

  const call = await mcpCall(options.baseUrl, options.declarationId, init.sessionId, 'tools/call', { name: expectedTool, arguments: {} }, fetchImpl);
  const result = call.body.result as { isError?: boolean; content?: readonly { text?: string }[] } | undefined;
  if (result?.isError) {
    const text = result.content?.[0]?.text ?? '(no detail)';
    return { kind: 'unexpected-profile-or-catalog', detail: `'${expectedTool}' call failed: ${text}` };
  }

  return { kind: 'verified', commitSha: stability.stableCommit };
}

function reportLine(classification: DeploymentClassification): string {
  switch (classification.kind) {
    case 'verified':
      return `verify-deployment: verified — commit ${classification.commitSha}`;
    case 'stale-runtime':
      return `verify-deployment: stale-runtime — expected ${classification.expectedCommit}, observed ${classification.observedCommit}`;
    case 'mixed-runtime':
      return `verify-deployment: mixed-runtime — observed commits: ${classification.observedCommits.join(', ')}`;
    case 'verification-credential':
      return `verify-deployment: verification-credential — ${classification.detail}`;
    case 'unexpected-profile-or-catalog':
      return `verify-deployment: unexpected-profile-or-catalog — ${classification.detail}`;
  }
}

function parseArgs(argv: readonly string[]): VerifyDeploymentOptions {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error('usage: verify-deployment.ts --base-url <url> --declaration <id> --expected-commit <sha> --token <bearer> [--expected-tool <name>]');
    }
    flags.set(key.slice(2), value);
  }
  const baseUrl = flags.get('base-url');
  const declarationId = flags.get('declaration');
  const expectedCommitSha = flags.get('expected-commit');
  const bearerToken = flags.get('token');
  if (!baseUrl || !declarationId || !expectedCommitSha || !bearerToken) {
    throw new Error('usage: verify-deployment.ts --base-url <url> --declaration <id> --expected-commit <sha> --token <bearer> [--expected-tool <name>]');
  }
  const expectedTool = flags.get('expected-tool');
  return {
    baseUrl,
    declarationId,
    expectedCommitSha,
    bearerToken,
    ...(expectedTool !== undefined ? { expectedTool } : {}),
  };
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const options = parseArgs(process.argv.slice(2));
  const classification = await verifyDeployment(options);
  console.log(reportLine(classification));
  process.exit(classification.kind === 'verified' ? 0 : 1);
}
