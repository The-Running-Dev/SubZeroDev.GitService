import type { ModuleTargetName } from '../shared/brands.ts';
import type { CallContext, DomainOperation } from '../shared/call-context.ts';
import { ok, err, type Outcome } from '../shared/outcome.ts';
import type { JsonValue } from '../contract/json.ts';
import { infrastructure, type ToolResult } from '../result/envelope.ts';
import { moduleAdapterError, type ModuleAdapterError } from './errors.ts';

export type ModuleHandler = (ctx: CallContext, input: JsonValue) => Promise<ToolResult<JsonValue>>;

/**
 * Bridges a domain module's typed `DomainOperation` (git operations, and
 * every future L2 module) into the untyped `ModuleHandler` this adapter
 * registers. The cast is exactly this: a plain-data `TInput`/`TData` is
 * structurally a `JsonValue` at runtime (the contract's own convention for
 * every tool input/output), and `unknown` is the only honest way to say
 * that once through `JsonValue`'s recursive shape, which TypeScript cannot
 * verify structurally.
 */
export function toModuleHandler<TInput, TData>(op: DomainOperation<TInput, TData>): ModuleHandler {
  return (ctx, input) => op(ctx, input as unknown as TInput) as unknown as Promise<ToolResult<JsonValue>>;
}

export interface ModuleAdapter {
  register(target: ModuleTargetName, handler: ModuleHandler): Outcome<void, ModuleAdapterError>;
  invoke(target: ModuleTargetName, ctx: CallContext, input: JsonValue): Promise<ToolResult<JsonValue>>;
  registeredTargets(): ReadonlySet<ModuleTargetName>;
}

/** `20-contract.md` § L3 — module adapter. Populated by registration at composition time; never imports a handler. */
export function createModuleAdapter(): ModuleAdapter {
  const handlers = new Map<ModuleTargetName, ModuleHandler>();

  return {
    register(target, handler): Outcome<void, ModuleAdapterError> {
      if (handlers.has(target)) {
        return err(moduleAdapterError({ code: 'duplicate-registration', target }, `target '${target}' is already registered`));
      }
      handlers.set(target, handler);
      return ok(undefined);
    },

    async invoke(target, ctx, input): Promise<ToolResult<JsonValue>> {
      const handler = handlers.get(target);
      if (!handler) {
        // Composition/boot verifies every registry entry has an executor
        // (invariant B5); reaching this at runtime is a defect, not a caller
        // error.
        return infrastructure(`no executor registered for target '${target}'`);
      }
      return handler(ctx, input);
    },

    registeredTargets(): ReadonlySet<ModuleTargetName> {
      return new Set(handlers.keys());
    },
  };
}
