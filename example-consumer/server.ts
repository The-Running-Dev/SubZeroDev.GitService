import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeAndStart } from '../src/composition-root/compose.ts';
import { toModuleHandler } from '../src/module-adapter/module-adapter.ts';
import { EXAMPLE_NOTE_ECHO_HANDLER, EXAMPLE_NOTE_ECHO_TARGET, EXTRA_TOOL_DECLARATIONS } from './declarations.ts';

/**
 * The example consumer's own composition root (S35.2). Calls the base's
 * published `composeAndStart` with its own extra declaration and handler,
 * and its own `buildDir`/`consoleDir` — the registry artifact and console
 * bundle this workspace's own build produces, not the base's.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await composeAndStart({
  buildDir: path.join(repoRoot, 'example-consumer', 'build'),
  consoleDir: path.join(repoRoot, 'example-consumer', 'console', 'dist'),
  extraToolDeclarations: EXTRA_TOOL_DECLARATIONS,
  extraModuleHandlers: [{ target: EXAMPLE_NOTE_ECHO_TARGET, handler: toModuleHandler(EXAMPLE_NOTE_ECHO_HANDLER) }],
});
