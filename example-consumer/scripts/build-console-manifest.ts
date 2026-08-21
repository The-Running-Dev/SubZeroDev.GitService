import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeConsoleDigest, CONSOLE_HASH_FILENAME } from '../../src/lifecycle/console-integrity.ts';

/**
 * Runs `vite build` in `example-consumer/console/`, then writes the
 * companion hash file boot's `verifyConsoleArtifact` reads back — the same
 * shape as the base's own `scripts/build-console-manifest.ts`, pointed at
 * this workspace's own console build instead.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const consoleWorkspace = path.join(repoRoot, 'example-consumer', 'console');
const consoleDir = path.join(consoleWorkspace, 'dist');

function fail(message: string): never {
  console.error(`example-consumer build-console-manifest: ${message}`);
  process.exit(1);
}

execFileSync('npm', ['run', 'build'], { cwd: consoleWorkspace, stdio: 'inherit' });

const hash = await computeConsoleDigest(consoleDir).catch((cause) => {
  fail(`could not read the built console directory: ${cause instanceof Error ? cause.message : String(cause)}`);
});

await writeFile(path.join(consoleDir, CONSOLE_HASH_FILENAME), `${hash}\n`, 'utf8');
console.log(`example-consumer build-console-manifest: emitted ${path.join(consoleDir, CONSOLE_HASH_FILENAME)}`);
console.log(`example-consumer build-console-manifest: console digest (for boot's tamper check): ${hash}`);
