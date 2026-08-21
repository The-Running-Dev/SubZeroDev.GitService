import { composeAndStart } from './composition-root/compose.ts';

/**
 * The base's own consumption of its published composition entry
 * (`src/composition-root/compose.ts`) — no extras, the same relationship
 * `console/src/main.tsx` has to `createConsole()`. A consumer's own
 * composition root imports `composeAndStart` directly and supplies its own
 * extras; it does not go through this file.
 */
await composeAndStart();
