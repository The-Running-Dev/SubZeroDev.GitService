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
 * `capabilityGrant` is the declaration's own grant, not the operator
 * session's effective grant (`effectiveGrant` in
 * `src/dispatch/dispatch-pipeline.ts`, which additionally narrows by
 * contract, ceiling and session). The two agree today only because operator
 * sessions currently hold the full grant (`design/90-decisions.md`,
 * 2026-08-08); once S13 gives sessions their own narrower, durable grant,
 * this can offer a view the operator's actual session can't use. See
 * `design/90-decisions.md`'s `## Open` for this gap, tracked against S13.
 */
export function eligibleViews(
  views: readonly ConsoleViewRegistration[],
  capabilityGrant: readonly string[],
): readonly ConsoleViewRegistration[] {
  const grant = new Set(capabilityGrant);
  return views.filter((view) => view.capabilities.every((c) => grant.has(c)));
}
