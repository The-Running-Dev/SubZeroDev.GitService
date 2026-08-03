import type { Brand } from '../shared/brands.ts';

export type JsonPrimitive = string | number | boolean | null;
export interface JsonArray extends ReadonlyArray<JsonValue> {}
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;
export type JsonSchema = Brand<JsonObject, 'JsonSchema'>;

export function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
