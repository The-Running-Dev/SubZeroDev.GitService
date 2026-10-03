import type { ReactElement } from 'react';

/**
 * `20-contract.md` § "Console view registration" (L5, published package).
 * `TElement` is fixed to React's element type here — S18 already fixed the
 * framework binding, so the generic the design doc keeps open (U7) resolves
 * to `ReactElement` for every consumer of this package.
 */
export interface ConsoleViewProps {
  readonly declarationId: string;
}

export interface ConsoleViewRegistration {
  readonly id: string;
  readonly title: string;
  readonly capabilities: readonly string[];
  readonly render: (props: ConsoleViewProps) => ReactElement;
}

/**
 * S19.4: a view renders for a declaration whose grant contains every
 * capability it declares, and is absent otherwise. Pure and declaration-
 * agnostic — `views` never names the declaration it belongs to (S19.5), it
 * only carries the capabilities it needs; the caller supplies the grant to
 * check them against.
 *
 * The grant passed in is the declaration's `effectiveGrant` as the server
 * computed it (A12) — the contract, ceiling, session and declaration
 * intersection — never the declaration's raw `capabilityGrant` and never
 * recomputed client-side.
 */
export function eligibleViews(
  views: readonly ConsoleViewRegistration[],
  effectiveGrant: readonly string[],
): readonly ConsoleViewRegistration[] {
  const grant = new Set(effectiveGrant);
  return views.filter((view) => view.capabilities.every((c) => grant.has(c)));
}
