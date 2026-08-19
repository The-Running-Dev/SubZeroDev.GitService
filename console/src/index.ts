/**
 * The published package's public surface (`20-contract.md` § "Console view
 * registration", S19). A consumer imports `ConsoleViewRegistration` to
 * declare a view and `createConsole` to build its own console, adding
 * views to the base's shell rather than forking it.
 */
export type { ConsoleViewProps, ConsoleViewRegistration } from './view-registry.ts';
export { eligibleViews } from './view-registry.ts';
export { createConsole } from './console-root.tsx';
