import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compiler } from '../../src/contract/compiler.ts';
import { PRODUCTION_TOOL_DECLARATIONS } from '../../src/composition-root/production-declarations.ts';
import { EXTRA_TOOL_DECLARATIONS } from '../declarations.ts';

/**
 * The consumer half of `20-contract.md` § *Tool registry extension*: compiles
 * `PRODUCTION_TOOL_DECLARATIONS` unioned with this workspace's own
 * `EXTRA_TOOL_DECLARATIONS` through the same `compiler` the base's
 * `scripts/build-registry.ts` uses, and emits the artifact under this
 * workspace's own `build/` — never the base's — so the derived image's
 * registry fingerprint (S35.3) is computed over both sets and travels
 * through boot's tamper check the same way the base's own does.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const buildDir = path.join(repoRoot, 'example-consumer', 'build');

function fail(message: string): never {
  console.error(`example-consumer build-registry: ${message}`);
  process.exit(1);
}

const declarations = [...PRODUCTION_TOOL_DECLARATIONS, ...EXTRA_TOOL_DECLARATIONS];
const result = compiler.compile(declarations);
if (!result.ok) {
  for (const error of result.error) {
    console.error(`example-consumer build-registry: ${error.code}: ${error.summary}`);
  }
  fail(`the derived declaration set failed to compile (${result.error.length} error(s))`);
}

await mkdir(buildDir, { recursive: true });

const registryJson = JSON.stringify(
  result.value.registry,
  (_key, value) => (value instanceof Set ? [...value].sort() : value),
  2,
);
const registryPath = path.join(buildDir, 'registry.json');
await writeFile(registryPath, registryJson, 'utf8');

const registryHash = createHash('sha256').update(registryJson, 'utf8').digest('hex');
await writeFile(path.join(buildDir, 'registry.json.sha256'), `${registryHash}\n`, 'utf8');

await writeFile(path.join(buildDir, 'registry.md'), result.value.documentation.markdown, 'utf8');

console.log(`example-consumer build-registry: base tools: ${PRODUCTION_TOOL_DECLARATIONS.length}, extra tools: ${EXTRA_TOOL_DECLARATIONS.length}, total: ${declarations.length}`);
console.log(`example-consumer build-registry: emitted ${registryPath}`);
console.log(`example-consumer build-registry: registry fingerprint: ${result.value.fingerprint}`);
