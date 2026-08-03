import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compiler } from '../src/contract/compiler.ts';
import { PRODUCTION_TOOL_DECLARATIONS } from '../src/composition-root/production-declarations.ts';
import { SELF_TEST_FIXTURES } from '../src/contract/self-test-fixtures.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(repoRoot, 'build');

function fail(message: string): never {
  console.error(`build-registry: ${message}`);
  process.exit(1);
}

async function runSelfTest(): Promise<void> {
  let accepted = 0;
  let rejected = 0;
  const problems: string[] = [];

  for (const fixture of SELF_TEST_FIXTURES) {
    const result = compiler.compile(fixture.declarations);
    if (fixture.expected === 'accept') {
      if (result.ok) {
        accepted += 1;
      } else {
        problems.push(`'${fixture.description}' should have been accepted, got: ${result.error.map((e) => e.code).join(', ')}`);
      }
      continue;
    }

    if (!result.ok && result.error.some((e) => e.code === fixture.expected)) {
      rejected += 1;
    } else if (result.ok) {
      problems.push(`'${fixture.description}' should have been rejected with '${fixture.expected}' but was accepted`);
    } else {
      problems.push(`'${fixture.description}' should have been rejected with '${fixture.expected}', got: ${result.error.map((e) => e.code).join(', ')}`);
    }
  }

  console.log(`build-registry: self-test fixtures — accepted: ${accepted}, rejected: ${rejected}`);

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`build-registry: ${problem}`);
    }
    fail(`${problems.length} self-test fixture(s) did not behave as expected`);
  }
}

async function emitProductionArtifact(): Promise<void> {
  const result = compiler.compile(PRODUCTION_TOOL_DECLARATIONS);
  if (!result.ok) {
    for (const error of result.error) {
      console.error(`build-registry: ${error.code}: ${error.summary}`);
    }
    fail(`the production declaration set failed to compile (${result.error.length} error(s))`);
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

  console.log(`build-registry: emitted ${registryPath}`);
  console.log(`build-registry: registry fingerprint: ${result.value.fingerprint}`);
  console.log(`build-registry: registry file hash (for boot's tamper check): ${registryHash}`);
}

await runSelfTest();
await emitProductionArtifact();
