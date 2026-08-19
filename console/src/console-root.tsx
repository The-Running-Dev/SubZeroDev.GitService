import { StrictMode } from 'react';
import type { ReactElement } from 'react';
import { App } from './App.tsx';
import type { ConsoleViewRegistration } from './view-registry.ts';

/**
 * The package's published build entry (`20-contract.md` § U7, resolved by
 * S19). A consumer's own `main.tsx` imports this from `@subzerodev-git/console`
 * and calls it with its additional views; the base's own `main.tsx` calls it
 * with none. Either way the result is mounted the same way.
 */
export function createConsole(views: readonly ConsoleViewRegistration[] = []): ReactElement {
  return (
    <StrictMode>
      <App views={views} />
    </StrictMode>
  );
}
