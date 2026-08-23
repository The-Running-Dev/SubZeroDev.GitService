import type { ModuleTargetName } from '../shared/brands.ts';
import { fixtureTool, moduleTarget } from './fixtures.ts';
import { MONITORING_WAIT_CAP_SECONDS } from './compiler.ts';
import type { CompilerError } from './compiler-errors.ts';
import type { JsonSchema } from './json.ts';
import type { ToolDeclaration } from './tool-declaration.ts';

export interface SelfTestFixture {
  readonly description: string;
  readonly declarations: readonly ToolDeclaration[];
  /** `'accept'`, or the single `CompilerError` code the build expects this fixture to trigger. */
  readonly expected: 'accept' | CompilerError['code'];
}

/**
 * Definition-of-done item 2: "unsafe, contradictory and incomplete contracts
 * fail the build, with the rejection counts stated." One crafted fixture per
 * `CompilerError` variant, plus one that must be accepted — a validator that
 * has never failed is not known to constrain anything. Shared between the
 * unit tests and `scripts/build-registry.ts`, so the build's stated counts
 * and the test suite can never silently drift apart.
 */
export const SELF_TEST_FIXTURES: readonly SelfTestFixture[] = [
  {
    description: 'a well-formed tool is accepted',
    declarations: [fixtureTool({ name: 'git_status' })],
    expected: 'accept',
  },
  {
    description: 'duplicate-tool-name: the same name declared twice',
    declarations: [
      fixtureTool({ name: 'git_status', target: moduleTarget('git_status_a') }),
      fixtureTool({ name: 'git_status', target: moduleTarget('git_status_b') }),
    ],
    expected: 'duplicate-tool-name',
  },
  {
    description: 'no-executor: an empty execution target identifier',
    declarations: [fixtureTool({ name: 'git_status', target: { kind: 'module', target: '' as ModuleTargetName } })],
    expected: 'no-executor',
  },
  {
    description: 'multiple-executors: two tools claiming one execution target',
    declarations: [
      fixtureTool({ name: 'git_status', target: moduleTarget('shared_target') }),
      fixtureTool({ name: 'git_log', target: moduleTarget('shared_target') }),
    ],
    expected: 'multiple-executors',
  },
  {
    description: 'capability-scope-mismatch: instance scope declaring a declaration-scoped capability',
    declarations: [fixtureTool({ name: 'git_status', capabilityScope: 'instance', capabilities: ['repo.read'] })],
    expected: 'capability-scope-mismatch',
  },
  {
    description: 'schema-invalid: inputSchema is not a JSON object',
    declarations: [fixtureTool({ name: 'git_status', inputSchema: [] as unknown as JsonSchema })],
    expected: 'schema-invalid',
  },
  {
    description: 'annotation-contradiction: read execution class declaring a write capability',
    declarations: [fixtureTool({ name: 'git_status', executionClass: 'read', capabilities: ['git.local.write'] })],
    expected: 'annotation-contradiction',
  },
  {
    description: 'reserved-name: blog_ prefix on a base tool',
    declarations: [fixtureTool({ name: 'blog_create_post' })],
    expected: 'reserved-name',
  },
  {
    description: 'limit-exceeds-cap: monitoring-wait timeout over the cap',
    declarations: [
      fixtureTool({
        name: 'wait_for_checks',
        executionClass: 'monitoring-wait',
        limits: { timeoutSeconds: MONITORING_WAIT_CAP_SECONDS + 1, maxResultBytes: 1_000_000 },
      }),
    ],
    expected: 'limit-exceeds-cap',
  },
  {
    // S39.2: ContentCapability's own type refuses this tail as a literal
    // (S39.1); 'as CapabilityName' is the widened-string arrival this
    // variant exists to catch, the only way a published consumer package
    // can deliver one.
    description: "capability-unscopable: a content.* capability whose final segment is neither 'read' nor 'write', arriving as a widened string",
    declarations: [fixtureTool({ name: 'content_publish', capabilities: ['content.post.delete' as never], executionClass: 'mutating' })],
    expected: 'capability-unscopable',
  },
];
