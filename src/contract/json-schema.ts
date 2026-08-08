import type { Finding } from '../shared/result-kind.ts';
import type { JsonSchema } from './json.ts';
import type { JsonValue } from './json.ts';

/**
 * A minimal, hand-rolled JSON Schema subset — `type`, `properties`,
 * `required`, `additionalProperties`, `items`, `enum`, `nullable` (via a
 * `type` array including `"null"`) — sufficient for every schema S6 ships and
 * every one a future slice is likely to need for a plain-data tool result.
 * Not a general-purpose validator (no `$ref`, `oneOf`, `pattern`, numeric
 * bounds): the contract fixes `JsonSchema` as a `JsonObject` brand and leaves
 * the validation engine to whichever module needs one first, and pulling in
 * a full implementation is a dependency `20-contract.md`'s "no new
 * dependencies" rule (`AGENTS.md`) would need a decision-log entry to justify
 * for a need this narrow.
 */

type SchemaObject = {
  readonly type?: string | readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchema | SchemaObject>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: JsonSchema | SchemaObject;
  readonly enum?: readonly JsonValue[];
};

function typeOf(value: JsonValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value: JsonValue, expected: string | readonly string[] | undefined): boolean {
  if (expected === undefined) return true;
  const allowed = Array.isArray(expected) ? expected : [expected];
  return allowed.includes(typeOf(value));
}

function validateNode(schema: JsonSchema | SchemaObject, value: JsonValue, at: string, findings: Finding[]): void {
  const node = schema as SchemaObject;

  if (!matchesType(value, node.type)) {
    findings.push({ path: at, rule: 'type', message: `expected ${Array.isArray(node.type) ? node.type.join('|') : node.type}, got ${typeOf(value)}` });
    return;
  }

  if (node.enum && !node.enum.some((allowed) => JSON.stringify(allowed) === JSON.stringify(value))) {
    findings.push({ path: at, rule: 'enum', message: `value not in the allowed set` });
    return;
  }

  if (typeOf(value) === 'object') {
    const obj = value as Readonly<Record<string, JsonValue>>;
    for (const requiredKey of node.required ?? []) {
      if (!(requiredKey in obj)) {
        findings.push({ path: `${at}.${requiredKey}`, rule: 'required', message: 'missing required property' });
      }
    }
    const properties = node.properties ?? {};
    for (const [key, propValue] of Object.entries(obj)) {
      const propSchema = properties[key];
      if (propSchema) {
        validateNode(propSchema, propValue, `${at}.${key}`, findings);
      } else if (node.additionalProperties === false) {
        findings.push({ path: `${at}.${key}`, rule: 'additionalProperties', message: 'property not permitted by the schema' });
      }
    }
  }

  if (typeOf(value) === 'array' && node.items) {
    (value as readonly JsonValue[]).forEach((item, index) => validateNode(node.items!, item, `${at}[${index}]`, findings));
  }
}

/** Validates `value` against `schema`, returning every finding — empty when the value satisfies the schema. */
export function validateAgainstSchema(schema: JsonSchema, value: JsonValue): readonly Finding[] {
  const findings: Finding[] = [];
  validateNode(schema, value, '$', findings);
  return findings;
}
