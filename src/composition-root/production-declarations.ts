import type { ModuleTargetName, RegistryToolName } from '../shared/brands.ts';
import type { JsonSchema } from '../contract/json.ts';
import type { ToolDeclaration } from '../contract/tool-declaration.ts';

function toolName(name: string): RegistryToolName {
  return name as RegistryToolName;
}

function moduleTarget(target: string): { readonly kind: 'module'; readonly target: ModuleTargetName } {
  return { kind: 'module', target: target as ModuleTargetName };
}

const EMPTY_INPUT_SCHEMA = { type: 'object', properties: {}, additionalProperties: false } as unknown as JsonSchema;

const READ_STAMP_SCHEMA = {
  type: 'object',
  properties: {
    lastSettledOperationId: { type: ['string', 'null'] },
    mutationInFlight: { type: 'boolean' },
  },
  required: ['lastSettledOperationId', 'mutationInFlight'],
} as const;

const REPO_STATUS_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    branch: { type: 'string' },
    baseBranch: { type: 'string' },
    dirty: { type: 'boolean' },
    parkedOffBase: { type: 'boolean' },
    ahead: { type: 'number' },
    behind: { type: 'number' },
    changedPaths: {
      type: 'array',
      items: { type: 'object', properties: { path: { type: 'string' }, staged: { type: 'boolean' } }, required: ['path', 'staged'] },
    },
    observedRemote: { type: ['string', 'null'] },
    readStamp: READ_STAMP_SCHEMA,
  },
  required: ['branch', 'baseBranch', 'dirty', 'parkedOffBase', 'ahead', 'behind', 'changedPaths', 'observedRemote', 'readStamp'],
} as unknown as JsonSchema;

const GIT_LOG_INPUT_SCHEMA = {
  type: 'object',
  properties: { ref: { type: ['string', 'null'] } },
  additionalProperties: false,
} as unknown as JsonSchema;

const GIT_LOG_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ref: { type: 'string' },
    commits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sha: { type: 'string' },
          authorName: { type: 'string' },
          authorEmail: { type: 'string' },
          authorDate: { type: 'string' },
          subject: { type: 'string' },
        },
        required: ['sha', 'authorName', 'authorEmail', 'authorDate', 'subject'],
      },
    },
    readStamp: READ_STAMP_SCHEMA,
  },
  required: ['ref', 'commits', 'readStamp'],
} as unknown as JsonSchema;

const GIT_BRANCHES_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    baseBranch: { type: 'string' },
    branches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          current: { type: 'boolean' },
          ahead: { type: 'number' },
          behind: { type: 'number' },
          lastCommitAt: { type: ['string', 'null'] },
        },
        required: ['name', 'current', 'ahead', 'behind', 'lastCommitAt'],
      },
    },
    readStamp: READ_STAMP_SCHEMA,
  },
  required: ['baseBranch', 'branches', 'readStamp'],
} as unknown as JsonSchema;

const REPO_HEALTH_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    branch: { type: 'string' },
    baseBranch: { type: 'string' },
    dirty: { type: 'boolean' },
    parkedOffBase: { type: 'boolean' },
    ahead: { type: 'number' },
    behind: { type: 'number' },
    commitsLast7Days: { type: 'number' },
    daysSinceLastCommit: { type: ['number', 'null'] },
    staleBranches: {
      type: 'object',
      properties: { count: { type: 'number' }, names: { type: 'array', items: { type: 'string' } } },
      required: ['count', 'names'],
    },
    readStamp: READ_STAMP_SCHEMA,
  },
  required: ['branch', 'baseBranch', 'dirty', 'parkedOffBase', 'ahead', 'behind', 'commitsLast7Days', 'daysSinceLastCommit', 'staleBranches', 'readStamp'],
} as unknown as JsonSchema;

const GIT_DIFF_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    staged: { type: 'boolean' },
    paths: { type: ['array', 'null'], items: { type: 'string' } },
  },
  required: ['staged', 'paths'],
  additionalProperties: false,
} as unknown as JsonSchema;

const GIT_DIFF_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    diff: { type: 'string' },
    checkClean: { type: 'boolean' },
    checkOutput: { type: 'string' },
    readStamp: READ_STAMP_SCHEMA,
  },
  required: ['diff', 'checkClean', 'checkOutput', 'readStamp'],
} as unknown as JsonSchema;

const PATHS_INPUT_SCHEMA = {
  type: 'object',
  properties: { paths: { type: 'array', items: { type: 'string' } } },
  required: ['paths'],
  additionalProperties: false,
} as unknown as JsonSchema;

const GIT_STAGE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { staged: { type: 'array', items: { type: 'string' } } },
  required: ['staged'],
} as unknown as JsonSchema;

const GIT_COMMIT_INPUT_SCHEMA = {
  type: 'object',
  properties: { message: { type: 'string' } },
  required: ['message'],
  additionalProperties: false,
} as unknown as JsonSchema;

const GIT_COMMIT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    sha: { type: 'string' },
    branch: { type: 'string' },
    changedPaths: { type: 'array', items: { type: 'string' } },
  },
  required: ['sha', 'branch', 'changedPaths'],
} as unknown as JsonSchema;

const GIT_RESTORE_PATHS_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { restored: { type: 'array', items: { type: 'string' } } },
  required: ['restored'],
} as unknown as JsonSchema;

const GIT_PUSH_INPUT_SCHEMA = {
  type: 'object',
  properties: { branch: { type: ['string', 'null'] } },
  required: ['branch'],
  // `additionalProperties: false` is what makes "no force option" a property of
  // the schema rather than of the handler: a caller cannot smuggle one in, and
  // the absence is readable straight off the compiled registry.
  additionalProperties: false,
} as unknown as JsonSchema;

const GIT_PUSH_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    branch: { type: 'string' },
    headSha: { type: 'string' },
    alreadyUpToDate: { type: 'boolean' },
  },
  required: ['branch', 'headSha', 'alreadyUpToDate'],
} as unknown as JsonSchema;

const GIT_FETCH_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    baseBranch: { type: 'string' },
    upstreamSha: { type: ['string', 'null'] },
    updatedRefs: { type: 'array', items: { type: 'string' } },
  },
  required: ['baseBranch', 'upstreamSha', 'updatedRefs'],
} as unknown as JsonSchema;

const SYNC_BASE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    baseBranch: { type: 'string' },
    headSha: { type: 'string' },
    upstreamSha: { type: 'string' },
    fastForwarded: { type: 'boolean' },
  },
  required: ['baseBranch', 'headSha', 'upstreamSha', 'fastForwarded'],
} as unknown as JsonSchema;

/**
 * The real, deployed tool inventory. S1 through S5 shipped none (U1 was
 * wholly open); S6 resolves U1 for the five read operations, S7 for the three
 * local mutations and S9 for the three remote ones, each shipping their
 * registry entries here — see `20-contract.md` § L2 — git operations for the
 * rationale behind each tool's capabilities, annotations and limits.
 */
export const PRODUCTION_TOOL_DECLARATIONS: readonly ToolDeclaration[] = [
  {
    name: toolName('repo_status'),
    description: 'Read-only snapshot of the current branch, working-tree cleanliness, ahead/behind counts against the base branch, and the observed remote.',
    inputSchema: EMPTY_INPUT_SCHEMA,
    outputSchema: REPO_STATUS_OUTPUT_SCHEMA,
    scopes: ['read'],
    capabilities: ['repo.read'],
    capabilityScope: 'declaration',
    executionClass: 'read',
    annotations: { schedulable: false, dropTarget: false, untrustedOutput: false },
    limits: { timeoutSeconds: 30, maxResultBytes: 65_536 },
    target: moduleTarget('git.status'),
  },
  {
    name: toolName('git_log'),
    description: "Recent commit history from a ref, defaulting to origin/<base> rather than HEAD so it reflects what's published, not wherever the checkout happens to be parked.",
    inputSchema: GIT_LOG_INPUT_SCHEMA,
    outputSchema: GIT_LOG_OUTPUT_SCHEMA,
    scopes: ['read'],
    capabilities: ['repo.read'],
    capabilityScope: 'declaration',
    executionClass: 'read',
    annotations: { schedulable: false, dropTarget: false, untrustedOutput: true },
    limits: { timeoutSeconds: 30, maxResultBytes: 1_048_576 },
    target: moduleTarget('git.log'),
  },
  {
    name: toolName('git_branches'),
    description: 'Lists local branches with ahead/behind counts against the base branch, each one’s last commit time, and which one is currently checked out.',
    inputSchema: EMPTY_INPUT_SCHEMA,
    outputSchema: GIT_BRANCHES_OUTPUT_SCHEMA,
    scopes: ['read'],
    capabilities: ['repo.read'],
    capabilityScope: 'declaration',
    executionClass: 'read',
    annotations: { schedulable: false, dropTarget: false, untrustedOutput: false },
    limits: { timeoutSeconds: 30, maxResultBytes: 262_144 },
    target: moduleTarget('git.branches'),
  },
  {
    name: toolName('repo_health'),
    description: 'Consolidated local repository health: branch, cleanliness, ahead/behind, recent commit activity and a stale-branch count. Local only — no host-derived data.',
    inputSchema: EMPTY_INPUT_SCHEMA,
    outputSchema: REPO_HEALTH_OUTPUT_SCHEMA,
    scopes: ['read'],
    capabilities: ['repo.read'],
    capabilityScope: 'declaration',
    executionClass: 'read',
    annotations: { schedulable: false, dropTarget: false, untrustedOutput: false },
    limits: { timeoutSeconds: 30, maxResultBytes: 65_536 },
    target: moduleTarget('git.health'),
  },
  {
    name: toolName('git_diff'),
    description: 'Shows a unified diff (staged or working tree), plus a whitespace/no-newline-at-eof check.',
    inputSchema: GIT_DIFF_INPUT_SCHEMA,
    outputSchema: GIT_DIFF_OUTPUT_SCHEMA,
    scopes: ['read'],
    capabilities: ['repo.read'],
    capabilityScope: 'declaration',
    executionClass: 'read',
    annotations: { schedulable: false, dropTarget: false, untrustedOutput: true },
    limits: { timeoutSeconds: 30, maxResultBytes: 4_194_304 },
    target: moduleTarget('git.diff'),
  },
  {
    name: toolName('git_stage'),
    description: 'Stages the given repository-relative paths, each checked against the declaration\'s writable path prefixes before anything is staged.',
    inputSchema: PATHS_INPUT_SCHEMA,
    outputSchema: GIT_STAGE_OUTPUT_SCHEMA,
    scopes: ['write'],
    capabilities: ['git.local.write'],
    capabilityScope: 'declaration',
    executionClass: 'mutating',
    annotations: { schedulable: false, dropTarget: false, untrustedOutput: false },
    limits: { timeoutSeconds: 30, maxResultBytes: 65_536 },
    target: moduleTarget('git.stage'),
  },
  {
    name: toolName('git_commit'),
    description: 'Commits whatever is currently staged, with the given message.',
    inputSchema: GIT_COMMIT_INPUT_SCHEMA,
    outputSchema: GIT_COMMIT_OUTPUT_SCHEMA,
    scopes: ['write'],
    capabilities: ['git.local.write'],
    capabilityScope: 'declaration',
    executionClass: 'mutating',
    annotations: { schedulable: false, dropTarget: false, untrustedOutput: false },
    limits: { timeoutSeconds: 30, maxResultBytes: 65_536 },
    target: moduleTarget('git.commit'),
  },
  {
    name: toolName('git_restore_paths'),
    description: 'Restores the given repository-relative paths to HEAD, discarding both staged and working-tree changes for those paths only. Each path is checked against the writable path prefixes before anything is restored.',
    inputSchema: PATHS_INPUT_SCHEMA,
    outputSchema: GIT_RESTORE_PATHS_OUTPUT_SCHEMA,
    scopes: ['write'],
    capabilities: ['git.local.write'],
    capabilityScope: 'declaration',
    executionClass: 'mutating',
    annotations: { schedulable: false, dropTarget: false, untrustedOutput: false },
    limits: { timeoutSeconds: 30, maxResultBytes: 65_536 },
    target: moduleTarget('git.restorePaths'),
  },
  {
    name: toolName('git_push'),
    description: 'Pushes a branch to origin. No force option exists in this tool\'s input schema, so no caller and no authority can request one.',
    inputSchema: GIT_PUSH_INPUT_SCHEMA,
    outputSchema: GIT_PUSH_OUTPUT_SCHEMA,
    scopes: ['write'],
    capabilities: ['git.remote.write'],
    capabilityScope: 'declaration',
    executionClass: 'mutating',
    annotations: { schedulable: false, dropTarget: false, untrustedOutput: false },
    limits: { timeoutSeconds: 300, maxResultBytes: 65_536 },
    target: moduleTarget('git.push'),
  },
  {
    name: toolName('git_fetch'),
    description: 'Fetches from origin, updating remote-tracking refs. Local branches and the working tree are untouched.',
    inputSchema: EMPTY_INPUT_SCHEMA,
    outputSchema: GIT_FETCH_OUTPUT_SCHEMA,
    scopes: ['write'],
    capabilities: ['git.remote.write'],
    capabilityScope: 'declaration',
    executionClass: 'mutating',
    annotations: { schedulable: false, dropTarget: false, untrustedOutput: false },
    limits: { timeoutSeconds: 300, maxResultBytes: 65_536 },
    target: moduleTarget('git.fetch'),
  },
  {
    name: toolName('sync_base'),
    description: 'Brings the local base branch up to origin by fast-forward only. A base that has diverged is refused, never rewritten.',
    inputSchema: EMPTY_INPUT_SCHEMA,
    outputSchema: SYNC_BASE_OUTPUT_SCHEMA,
    scopes: ['write'],
    capabilities: ['git.remote.write'],
    capabilityScope: 'declaration',
    executionClass: 'mutating',
    annotations: { schedulable: false, dropTarget: false, untrustedOutput: false },
    limits: { timeoutSeconds: 300, maxResultBytes: 65_536 },
    target: moduleTarget('git.syncBase'),
  },
];
