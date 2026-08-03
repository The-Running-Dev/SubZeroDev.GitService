export type Outcome<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T, E = never>(value: T): Outcome<T, E> {
  return { ok: true, value };
}

export function err<E, T = never>(error: E): Outcome<T, E> {
  return { ok: false, error };
}
