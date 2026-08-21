import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * Invariant B8: "The compiler is absent from the runtime image." Builds the
 * real module graph starting from the runtime entrypoint (`src/server.ts` by
 * default) using the TypeScript compiler API, and fails the build if
 * `src/contract/compiler.ts` is reachable from it. This is the check the
 * fingerprint-mismatch acceptance criterion in `30-slices.md` § S1 requires:
 * "A check fails the build if any runtime module imports the compiler."
 *
 * Takes one optional CLI argument: a runtime entrypoint path (relative to the
 * caller's cwd, or absolute), defaulting to `src/server.ts`. S35.4 reuses
 * this same check against `example-consumer/server.ts` — "the same check the
 * base runs" — rather than a second, separately-maintained copy of it.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeEntrypoint = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : path.join(repoRoot, 'src', 'server.ts');
const forbiddenModule = path.join(repoRoot, 'src', 'contract', 'compiler.ts');

function normalise(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, '/').toLowerCase();
}

const configPath = ts.findConfigFile(repoRoot, ts.sys.fileExists, 'tsconfig.json');
if (!configPath) {
  console.error('check-no-compiler-in-runtime: no tsconfig.json found');
  process.exit(1);
}

const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
  console.error('check-no-compiler-in-runtime: failed to read tsconfig.json');
  process.exit(1);
}

const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));

const program = ts.createProgram({ rootNames: [runtimeEntrypoint], options: parsedConfig.options });
const reachable = program.getSourceFiles().map((sourceFile) => normalise(sourceFile.fileName));

const target = normalise(forbiddenModule);
const violation = reachable.includes(target);

if (violation) {
  console.error(`check-no-compiler-in-runtime: ${runtimeEntrypoint} imports the compiler (${forbiddenModule}), violating invariant B8`);
  process.exit(1);
}

console.log(`check-no-compiler-in-runtime: OK — ${reachable.length} runtime module(s) reachable from ${path.relative(process.cwd(), runtimeEntrypoint)}, none is the compiler`);
