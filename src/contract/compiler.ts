import { err, ok, type Outcome } from '../shared/outcome.ts';
import { isoUtcTimestamp, type RegistryToolName, type Sha256Hex } from '../shared/brands.ts';
import type { Finding } from '../shared/result-kind.ts';
import { capabilityScopeOf, type CapabilityName, type ContractCapabilitySet } from './capabilities.ts';
import { computeFingerprint, normaliseEntryOrder } from './fingerprint.ts';
import { isJsonObject } from './json.ts';
import type { SchemaObject } from './json-schema.ts';
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

// Every CompilerError variant means "these declarations do not satisfy the
// contract" — the caller's input, not the build environment — so 'validation'
// is the correct ResultKind (see `20-contract.md` § The result envelope: it
// reads exactly "caller input does not satisfy the contract"), not
// 'infrastructure', which `isError` treats as a service/environment failure.
function moduleError<T extends { readonly code: CompilerError['code'] }>(base: T, summary: string): CompilerError {
  return { resultKind: 'validation', retryable: false, summary, ...base } as unknown as CompilerError;
}

function schemaObject(value: unknown): SchemaObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as SchemaObject) : null;
}

function hasExactType(schema: SchemaObject, expected: string): boolean {
  return schema.type === expected || (Array.isArray(schema.type) && schema.type.length === 1 && schema.type[0] === expected);
}

function requireObject(value: unknown, path: string, findings: Finding[]): SchemaObject | null {
  const schema = schemaObject(value);
  if (!schema || !hasExactType(schema, 'object')) {
    findings.push({ path, rule: 'watcher-schema-projection', message: 'must declare type object' });
    return null;
  }
  return schema;
}

function requireProperty(schema: SchemaObject, property: string, path: string, findings: Finding[]): SchemaObject | null {
  if (!schema.required?.includes(property)) {
    findings.push({ path: `${path}.required`, rule: 'watcher-schema-projection', message: `must require '${property}'` });
  }
  const value = schema.properties?.[property];
  const propertySchema = schemaObject(value);
  if (!propertySchema) {
    findings.push({ path: `${path}.properties.${property}`, rule: 'watcher-schema-projection', message: 'must declare a schema' });
    return null;
  }
  return propertySchema;
}

function requireStringProperty(schema: SchemaObject, property: string, path: string, findings: Finding[]): void {
  const propertySchema = requireProperty(schema, property, path, findings);
  if (propertySchema && !hasExactType(propertySchema, 'string')) {
    findings.push({ path: `${path}.properties.${property}.type`, rule: 'watcher-schema-projection', message: 'must be string' });
  }
}

function requireStringArrayProperty(schema: SchemaObject, property: string, path: string, findings: Finding[]): void {
  const propertySchema = requireProperty(schema, property, path, findings);
  if (!propertySchema) return;
  if (!hasExactType(propertySchema, 'array')) {
    findings.push({ path: `${path}.properties.${property}.type`, rule: 'watcher-schema-projection', message: 'must be array' });
    return;
  }
  const items = schemaObject(propertySchema.items);
  if (!items || !hasExactType(items, 'string')) {
    findings.push({ path: `${path}.properties.${property}.items.type`, rule: 'watcher-schema-projection', message: 'must be string' });
  }
}

function validateWatcherSchemas(declaration: ToolDeclaration): Finding[] {
  const phase = declaration.annotations.fileWatcher;
  if (phase === false) return [];

  const findings: Finding[] = [];
  if (phase === 'plan') {
    const input = requireObject(declaration.inputSchema, 'inputSchema', findings);
    if (input) {
      requireStringProperty(input, 'sourceFile', 'inputSchema', findings);
      requireStringProperty(input, 'content', 'inputSchema', findings);
    }

    const output = requireObject(declaration.outputSchema, 'outputSchema', findings);
    if (output) {
      requireStringProperty(output, 'branch', 'outputSchema', findings);
      requireStringProperty(output, 'commitMessage', 'outputSchema', findings);
      requireStringArrayProperty(output, 'permittedPaths', 'outputSchema', findings);
      requireProperty(output, 'plan', 'outputSchema', findings);
      const pullRequest = requireProperty(output, 'pullRequest', 'outputSchema', findings);
      if (pullRequest) {
        const pullRequestObject = requireObject(pullRequest, 'outputSchema.properties.pullRequest', findings);
        if (pullRequestObject) {
          requireStringProperty(pullRequestObject, 'title', 'outputSchema.properties.pullRequest', findings);
          requireStringProperty(pullRequestObject, 'body', 'outputSchema.properties.pullRequest', findings);
        }
      }
    }
  } else {
    const input = requireObject(declaration.inputSchema, 'inputSchema', findings);
    if (input) {
      requireStringArrayProperty(input, 'permittedPaths', 'inputSchema', findings);
      requireProperty(input, 'plan', 'inputSchema', findings);
    }

    const output = requireObject(declaration.outputSchema, 'outputSchema', findings);
    if (output) {
      requireStringArrayProperty(output, 'changedPaths', 'outputSchema', findings);
    }
  }

  return findings;
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
  const watcherPhase = declaration.annotations.fileWatcher;
  if (watcherPhase !== false) {
    const schemaFindings = validateWatcherSchemas(declaration);
    if (schemaFindings.length > 0) {
      errors.push(moduleError({ code: 'schema-invalid', name, findings: schemaFindings }, `tool '${name}' does not project the fixed file-watcher ${watcherPhase} schema`));
    }
    const isPlan = watcherPhase === 'plan';
    const capabilitiesValid = isPlan
      ? declaration.capabilities.length === 0
      : declaration.capabilities.length === 1 && declaration.capabilities[0] === 'git.local.write';
    const watcherChecks: readonly (readonly [boolean, string])[] = [
      [declaration.target.kind === 'module', 'target must be a module tool'],
      [declaration.executionClass === (isPlan ? 'read' : 'mutating'), `executionClass must be '${isPlan ? 'read' : 'mutating'}'`],
      [declaration.capabilityScope === 'declaration', "capabilityScope must be 'declaration'"],
      [declaration.scopes.length === 1 && declaration.scopes[0] === 'write', "scopes must be exactly ['write']"],
      [capabilitiesValid, isPlan ? 'capabilities must be empty' : "capabilities must be exactly ['git.local.write']"],
      [declaration.annotations.schedulable === false, 'schedulable must be false'],
      [declaration.annotations.untrustedOutput === true, 'untrustedOutput must be true'],
    ];
    for (const [valid, reason] of watcherChecks) {
      if (!valid) {
        errors.push(moduleError({ code: 'annotation-contradiction', name, rule: `file-watcher ${watcherPhase} shape: ${reason}` }, `tool '${name}' does not satisfy the fixed file-watcher ${watcherPhase} shape: ${reason}`));
      }
    }
  }

  const limitFields = [
    ['timeoutSeconds', declaration.limits.timeoutSeconds],
    ['maxResultBytes', declaration.limits.maxResultBytes],
  ] as const;
  for (const [field, value] of limitFields) {
    if (!Number.isInteger(value) || value <= 0) {
      errors.push(
        moduleError(
          { code: 'limit-exceeds-cap', name, cap: 1 },
          `tool '${name}' ${field} must be a positive integer`,
        ),
      );
    }
  }

  if (
    declaration.executionClass === 'monitoring-wait' &&
    Number.isInteger(declaration.limits.timeoutSeconds) &&
    declaration.limits.timeoutSeconds > MONITORING_WAIT_CAP_SECONDS
  ) {
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
