import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeConsoleDigest, CONSOLE_HASH_FILENAME } from '../src/lifecycle/console-integrity.ts';

/**
 * Runs `vite build` in `console/`, then writes the companion hash file
 * `console-integrity.ts`'s `verifyConsoleArtifact` reads back at boot —
 * mirrors `build-registry.ts`'s `registry.json.sha256` exactly, one level up
 * (a whole built directory rather than one JSON file).
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const consoleWorkspace = path.join(repoRoot, 'console');
const consoleDir = path.join(consoleWorkspace, 'dist');

function fail(message: string): never {
  console.error(`build-console-manifest: ${message}`);
  process.exit(1);
}

execFileSync('npm', ['run', 'build'], { cwd: consoleWorkspace, stdio: 'inherit' });

const hash = await computeConsoleDigest(consoleDir).catch((cause) => {
  fail(`could not read the built console directory: ${cause instanceof Error ? cause.message : String(cause)}`);
});

await writeFile(path.join(consoleDir, CONSOLE_HASH_FILENAME), `${hash}\n`, 'utf8');
console.log(`build-console-manifest: emitted ${path.join(consoleDir, CONSOLE_HASH_FILENAME)}`);
console.log(`build-console-manifest: console digest (for boot's tamper check): ${hash}`);
