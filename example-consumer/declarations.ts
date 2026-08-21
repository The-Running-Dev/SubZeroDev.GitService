import type { JsonSchema } from '../src/contract/json.ts';
import type { ModuleTargetName, RegistryToolName } from '../src/shared/brands.ts';
import type { ToolDeclaration } from '../src/contract/tool-declaration.ts';
import type { CallContext } from '../src/shared/call-context.ts';
import type { ToolResult } from '../src/result/envelope.ts';
import { success } from '../src/result/envelope.ts';

/**
 * S35's example consumer — proof that a consumer can add its own tool on top
 * of the base's `PRODUCTION_TOOL_DECLARATIONS`, per `20-contract.md` §
 * *Tool registry extension*. One trivial read tool, `example_note_echo`,
 * declaring a capability (`content.exampleNote.read`) the base does not: S35.5
 * is exercised by the existing, unmodified `tools/list` visibility filter
 * (`src/dispatch/dispatch-pipeline.ts`'s `isVisible`) rather than by any new
 * mechanism.
 */

const ECHO_INPUT_SCHEMA = {
  type: 'object',
  properties: { message: { type: 'string' } },
  required: ['message'],
  additionalProperties: false,
} as unknown as JsonSchema;

const ECHO_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { echoed: { type: 'string' } },
  required: ['echoed'],
} as unknown as JsonSchema;

export const EXAMPLE_NOTE_ECHO_TARGET = 'content.exampleNoteEcho' as ModuleTargetName;

async function echo(ctx: CallContext, input: { readonly message: string }): Promise<ToolResult<{ echoed: string }>> {
  return success(`echoed '${input.message}'`, { echoed: input.message }, {
    operationId: ctx.operationId,
    declarationId: ctx.declarationId,
    generation: ctx.generation,
    durationMs: 0,
  });
}

export const EXAMPLE_NOTE_ECHO_HANDLER = echo;

export const EXTRA_TOOL_DECLARATIONS: readonly ToolDeclaration[] = [
  {
    name: 'example_note_echo' as RegistryToolName,
    description: "The example consumer's one added tool: echoes a message back, proving a consumer-declared capability the base does not grant.",
    inputSchema: ECHO_INPUT_SCHEMA,
    outputSchema: ECHO_OUTPUT_SCHEMA,
    scopes: ['read'],
    capabilities: ['content.exampleNote.read'],
    capabilityScope: 'declaration',
    executionClass: 'read',
    annotations: { schedulable: false, fileWatcher: false, untrustedOutput: false },
    limits: { timeoutSeconds: 30, maxResultBytes: 65_536 },
    target: { kind: 'module', target: EXAMPLE_NOTE_ECHO_TARGET },
  },
];
