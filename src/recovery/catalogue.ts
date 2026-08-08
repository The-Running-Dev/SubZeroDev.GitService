import { ok, err, type Outcome } from '../shared/outcome.ts';
import type { RegistryToolName } from '../shared/brands.ts';
import { recoveryCatalogueError, type RecoveryCatalogueError } from './errors.ts';
import type { RecoveryDescriptor } from './types.ts';

/**
 * `20-contract.md` § L1 — recovery catalogue.
 *
 * Recovery needs to know what each operation was *supposed* to achieve, and
 * that is L2 knowledge sitting above the two L1 modules that drive recovery
 * (`10-design.md` § the recovery catalogue). Holding descriptors here, keyed
 * by registry tool name and populated by the composition root, is the cut
 * that keeps the dependency graph acyclic: L1 resolves a descriptor by name
 * and never learns what a branch is.
 *
 * The same shape as the module adapter's handler catalogue and the
 * scheduler's pipeline — a name resolved at startup is how everything above
 * and below L2 reaches it.
 */
export interface RecoveryCatalogue {
  register(descriptor: RecoveryDescriptor): Outcome<void, RecoveryCatalogueError>;
  lookup(tool: RegistryToolName): RecoveryDescriptor | null;
  registeredTools(): ReadonlySet<RegistryToolName>;
}

export function createRecoveryCatalogue(): RecoveryCatalogue {
  const byTool = new Map<RegistryToolName, RecoveryDescriptor>();

  return {
    register(descriptor: RecoveryDescriptor): Outcome<void, RecoveryCatalogueError> {
      if (byTool.has(descriptor.tool)) {
        return err(
          recoveryCatalogueError(
            { code: 'duplicate-registration', tool: descriptor.tool },
            `a recovery descriptor is already registered for '${descriptor.tool}'`,
          ),
        );
      }
      byTool.set(descriptor.tool, descriptor);
      return ok(undefined);
    },

    lookup(tool: RegistryToolName): RecoveryDescriptor | null {
      return byTool.get(tool) ?? null;
    },

    registeredTools(): ReadonlySet<RegistryToolName> {
      return new Set(byTool.keys());
    },
  };
}
