import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonSchema } from './json.ts';
import { validateAgainstSchema } from './json-schema.ts';

const OBJECT_SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string' }, count: { type: 'number' } },
  required: ['name'],
  additionalProperties: false,
} as unknown as JsonSchema;

test('a value satisfying the schema produces no findings', () => {
  assert.deepEqual(validateAgainstSchema(OBJECT_SCHEMA, { name: 'a', count: 1 }), []);
});

test('a missing required property is reported', () => {
  const findings = validateAgainstSchema(OBJECT_SCHEMA, { count: 1 });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.rule, 'required');
});

test('an additional property is reported when additionalProperties is false', () => {
  const findings = validateAgainstSchema(OBJECT_SCHEMA, { name: 'a', extra: true });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.rule, 'additionalProperties');
});

test('a type mismatch is reported', () => {
  const findings = validateAgainstSchema(OBJECT_SCHEMA, { name: 42 });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.rule, 'type');
});

test('a nullable type array accepts null', () => {
  const schema = { type: 'object', properties: { x: { type: ['string', 'null'] } } } as unknown as JsonSchema;
  assert.deepEqual(validateAgainstSchema(schema, { x: null }), []);
  assert.deepEqual(validateAgainstSchema(schema, { x: 'hi' }), []);
});

test('array items are validated element-wise', () => {
  const schema = { type: 'array', items: { type: 'string' } } as unknown as JsonSchema;
  assert.deepEqual(validateAgainstSchema(schema, ['a', 'b']), []);
  const findings = validateAgainstSchema(schema, ['a', 1]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.path, '$[1]');
});
