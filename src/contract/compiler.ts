import { err, ok, type Outcome } from '../shared/outcome.ts';
import { isoUtcTimestamp, type RegistryToolName, type Sha256Hex } from '../shared/brands.ts';
import { capabilityScopeOf, type CapabilityName, type ContractCapabilitySet } from './capabilities.ts';
import { computeFingerprint, normaliseEntryOrder } from './fingerprint.ts';
import { isJsonObject } from './json.ts';
import type { CompiledRegistry, CompilerArtifact, ExecutionTarget, ToolDeclaration } from './tool-declaration.ts';
import type { CompilerError } from './compiler-errors.ts';

/**
 * The contract's stated default for `monitoringWaitCapSeconds` (`20-contract.md`
 * § Deployment configuration). Deployments may lower it (U6), never raise it
 * past this build-time ceiling — that is what `limit-exceeds-cap` protects.
 */
export const MONITORING_WAIT_CAP_SECONDS = 1800;

const NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function isReadCapability(capability: CapabilityName): boolean {
  return capability.endsWith('.read');
}

function targetIdentifier(target: ExecutionTarget): string {
  return target.kind === 'module' ? target.target : target.operation;
}

function targetKey(target: ExecutionTarget): string {
  return `${target.kind}:${targetIdentifier(target)}`;
}

function moduleError<T extends { readonly code: CompilerError['code'] }>(base: T, summary: string): CompilerError {
  return { resultKind: 'infrastructure', retryable: false, summary, ...base } as unknown as CompilerError;
}

function validateOne(declaration: ToolDeclaration): CompilerError[] {
  const errors: CompilerError[] = [];
  const name = declaration.name;

  if (!NAME_PATTERN.test(name) || name.startsWith('blog_')) {
    errors.push(moduleError({ code: 'reserved-name', name }, `tool name '${name}' fails naming policy`));
  }

  if (!isJsonObject(declaration.inputSchema) || !isJsonObject(declaration.outputSchema)) {
    errors.push(
      moduleError(
        {
          code: 'schema-invalid',
          name,
          findings: [{ path: 'inputSchema|outputSchema', rule: 'must-be-json-object', message: 'schema is not a JSON object' }],
        },
        `tool '${name}' has a non-object schema`,
      ),
    );
  }

  for (const capability of declaration.capabilities) {
    if (capabilityScopeOf(capability) !== declaration.capabilityScope) {
      errors.push(
        moduleError(
          { code: 'capability-scope-mismatch', name, capability },
          `tool '${name}' declares capabilityScope '${declaration.capabilityScope}' but capability '${capability}' is '${capabilityScopeOf(capability)}'-scoped`,
        ),
      );
    }
  }

  const hasWriteCapability = declaration.capabilities.some((c) => !isReadCapability(c));
  if (declaration.executionClass === 'read' && hasWriteCapability) {
    errors.push(
      moduleError(
        { code: 'annotation-contradiction', name, rule: 'read execution class declaring a write capability' },
        `tool '${name}' is 'read' but declares a write capability`,
      ),
    );
  }
  if (declaration.executionClass === 'monitoring-wait' && hasWriteCapability) {
    errors.push(
      moduleError(
        { code: 'annotation-contradiction', name, rule: 'monitoring-wait declaring a mutating capability' },
        `tool '${name}' is 'monitoring-wait' but declares a mutating capability`,
      ),
    );
  }
  if (declaration.annotations.dropTarget && declaration.executionClass !== 'mutating') {
    errors.push(
      moduleError(
        { code: 'annotation-contradiction', name, rule: 'dropTarget tool that is not mutating' },
        `tool '${name}' is a drop target but is not 'mutating'`,
      ),
    );
  }

  if (declaration.executionClass === 'monitoring-wait' && declaration.limits.timeoutSeconds > MONITORING_WAIT_CAP_SECONDS) {
    errors.push(
      moduleError(
        { code: 'limit-exceeds-cap', name, cap: MONITORING_WAIT_CAP_SECONDS },
        `tool '${name}' timeoutSeconds exceeds the monitoring-wait cap of ${MONITORING_WAIT_CAP_SECONDS}`,
      ),
    );
  }

  if (targetIdentifier(declaration.target).trim().length === 0) {
    errors.push(moduleError({ code: 'no-executor', name }, `tool '${name}' names an empty execution target`));
  }

  return errors;
}

function validateCrossDeclaration(declarations: readonly ToolDeclaration[]): CompilerError[] {
  const errors: CompilerError[] = [];

  const byName = new Map<RegistryToolName, ToolDeclaration[]>();
  for (const declaration of declarations) {
    const bucket = byName.get(declaration.name);
    if (bucket) {
      bucket.push(declaration);
    } else {
      byName.set(declaration.name, [declaration]);
    }
  }
  for (const [name, bucket] of byName) {
    if (bucket.length > 1) {
      for (let i = 0; i < bucket.length; i += 1) {
        errors.push(moduleError({ code: 'duplicate-tool-name', name }, `tool name '${name}' is declared ${bucket.length} times`));
      }
    }
  }

  const byTarget = new Map<string, ToolDeclaration[]>();
  for (const declaration of declarations) {
    const key = targetKey(declaration.target);
    const bucket = byTarget.get(key);
    if (bucket) {
      bucket.push(declaration);
    } else {
      byTarget.set(key, [declaration]);
    }
  }
  for (const bucket of byTarget.values()) {
    if (bucket.length > 1) {
      for (const declaration of bucket) {
        errors.push(
          moduleError(
            { code: 'multiple-executors', name: declaration.name },
            `execution target '${targetKey(declaration.target)}' is claimed by ${bucket.length} tools`,
          ),
        );
      }
    }
  }

  return errors;
}

function nowIso() {
  const parsed = isoUtcTimestamp(new Date().toISOString());
  if (!parsed.ok) {
    throw new Error('Date.toISOString() did not produce a valid IsoUtcTimestamp — this is unreachable');
  }
  return parsed.value;
}

function generateMarkdown(entries: readonly ToolDeclaration[], fingerprint: Sha256Hex): string {
  const rows = entries
    .map((e) => `| \`${e.name}\` | ${e.executionClass} | ${e.capabilities.join(', ') || '—'} | ${e.scopes.join(', ') || '—'} |`)
    .join('\n');
  return [
    '# Generated tool registry',
    '',
    `Fingerprint: \`${fingerprint}\``,
    '',
    '| Tool | Execution class | Capabilities | Scopes |',
    '|---|---|---|---|',
    rows,
    '',
  ].join('\n');
}

export interface Compiler {
  compile(declarations: readonly ToolDeclaration[]): Outcome<CompilerArtifact, readonly CompilerError[]>;
  fingerprint(registry: CompiledRegistry): Sha256Hex;
}

export const compiler: Compiler = {
  compile(declarations: readonly ToolDeclaration[]): Outcome<CompilerArtifact, readonly CompilerError[]> {
    const errors: CompilerError[] = [];
    for (const declaration of declarations) {
      errors.push(...validateOne(declaration));
    }
    errors.push(...validateCrossDeclaration(declarations));

    if (errors.length > 0) {
      return err(errors);
    }

    const normalisedEntries = normaliseEntryOrder(declarations);
    const contractCapabilitySet = new Set(normalisedEntries.flatMap((e) => e.capabilities)) as unknown as ContractCapabilitySet;
    const fingerprint = computeFingerprint(normalisedEntries, contractCapabilitySet);

    const registry = {
      fingerprint,
      compiledAt: nowIso(),
      entries: normalisedEntries,
      contractCapabilitySet,
    };

    const manifest = {
      fingerprint,
      tools: normalisedEntries.map((e) => ({
        name: e.name,
        capabilities: e.capabilities,
        scopes: e.scopes,
        executionClass: e.executionClass,
      })),
    };

    return ok({
      registry,
      manifest,
      fingerprint,
      documentation: { markdown: generateMarkdown(normalisedEntries, fingerprint) },
    });
  },

  fingerprint(registry): Sha256Hex {
    return computeFingerprint(normaliseEntryOrder(registry.entries), registry.contractCapabilitySet);
  },
};
