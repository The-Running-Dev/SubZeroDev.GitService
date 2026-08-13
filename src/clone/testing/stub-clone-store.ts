import { ok, err } from '../../shared/outcome.ts';
import { cloneStoreError } from '../errors.ts';
import { NO_VOLUME_USAGE } from '../../store/volume-usage.ts';
import type { CloneStore } from '../clone-store.ts';

/**
 * A stub for tests that exercise a surface *around* the clone store without
 * exercising materialisation itself — mirrors `createStubDeclarations` and
 * `createStubOperatorIdentity`'s reasoning.
 */
export function createStubCloneStore(): CloneStore {
  return {
    async ensure() {
      return err(cloneStoreError({ code: 'clone-failed', cause: { resultKind: 'infrastructure', retryable: false, summary: 'stub', code: 'spawn-failed' } }, 'stub: ensure not exercised'));
    },
    async describe(declarationId) {
      return ok({
        declarationId,
        generation: 1 as never,
        state: 'absent',
        path: '' as never,
        sizeBytes: 0,
        lastOperationAt: null,
        observedRemote: null,
        attentionReason: null,
      });
    },
    async deriveAllStatesFromDisk() {
      return [];
    },
    async observeGitState() {
      return err(cloneStoreError({ code: 'needs-attention', reason: 'stub: observeGitState not exercised' }, 'stub'));
    },
    async isSafeToEvict() {
      return ok({ safe: true });
    },
    async evictIfSafe(declarationId) {
      return ok({ declarationId, evicted: false, freedBytes: 0, blockers: [] });
    },
    async remove() {
      return ok(undefined);
    },
    async markAttention() {
      return ok(undefined);
    },
    async clearAttention() {
      return ok(undefined);
    },
    async readVolumeUsage() {
      return ok(NO_VOLUME_USAGE);
    },
    async diskFullFindings() {
      return [];
    },
    requestMaintenance() {
      // no-op
    },
    async runRetention() {
      return { module: 'clone-store-stub', deletedRows: 0, freedBytes: 0, skipped: ['stub'] };
    },
  };
}
