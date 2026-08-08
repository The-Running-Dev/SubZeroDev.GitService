import { infrastructure } from '../../result/envelope.ts';
import type { DispatchPipeline } from '../dispatch-pipeline.ts';

/**
 * A stub for tests that exercise a surface *around* tool dispatch — the
 * health/version routes, declaration routes — without exercising dispatch
 * itself. Mirrors `createStubDeclarations` and `createStubCloneStore`'s
 * reasoning: every tool call reports "nothing registered", honest for a
 * pipeline built with an empty registry.
 */
export function createStubDispatchPipeline(): DispatchPipeline {
  return {
    visibleTools() {
      return [];
    },
    async dispatch() {
      return infrastructure('stub: dispatch not exercised');
    },
  };
}
