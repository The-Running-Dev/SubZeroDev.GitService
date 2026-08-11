import { err, ok } from '../../shared/outcome.ts';
import { declarationError } from '../errors.ts';
import type { Declarations } from '../declarations.ts';

/**
 * A stub for tests that exercise a surface *around* declarations — `/healthz`,
 * `/version`, `/health`, the console session routes — without exercising
 * declaration management itself. Every method reports "nothing declared",
 * which is honest for a module nobody has called `declare` on.
 */
export function createStubDeclarations(): Declarations {
  return {
    async get() {
      return null;
    },
    async getGeneration() {
      return null;
    },
    async list() {
      return [];
    },
    async declare() {
      return err(declarationError({ code: 'not-found' }, 'stub: declare not exercised'));
    },
    async amend() {
      return err(declarationError({ code: 'not-found' }, 'stub: amend not exercised'));
    },
    async orphan() {
      return err(declarationError({ code: 'not-found' }, 'stub: orphan not exercised'));
    },
    async remove() {
      return err(declarationError({ code: 'not-found' }, 'stub: remove not exercised'));
    },
    effectiveGrant(_contract, _ceiling, _declaration, _session) {
      return new Set() as unknown as ReturnType<Declarations['effectiveGrant']>;
    },
    effectiveWritablePrefixes(declaration) {
      return declaration.writablePathPrefixes;
    },
    bumpGrantEpoch() {
      return ok(0) as unknown as ReturnType<Declarations['bumpGrantEpoch']>;
    },
    remoteHostAllowlist() {
      return [];
    },
    async revalidateFileWatchers() {
      return ok(undefined);
    },
  };
}
