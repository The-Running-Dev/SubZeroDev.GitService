import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compiler } from '../src/contract/compiler.ts';
import { captureToolParity, type ToolParitySnapshot } from '../src/contract/tool-parity.ts';
import { PRODUCTION_TOOL_DECLARATIONS } from '../src/composition-root/production-declarations.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function fixturePath(): string {
  return path.join(repoRoot, 'fixtures', 'tool-parity', 'base-image.json');
}

/** Recompiles the base image's own production declarations and captures S36's per-profile snapshot from them. */
export function captureBaseImageToolParity(): readonly ToolParitySnapshot[] {
  const result = compiler.compile(PRODUCTION_TOOL_DECLARATIONS);
  if (!result.ok) {
    throw new Error(`the production declaration set failed to compile (${result.error.length} error(s)): ${result.error.map((e) => e.code).join(', ')}`);
  }
  return captureToolParity(result.value.registry);
}

export function readCommittedFixture(): readonly ToolParitySnapshot[] {
  return JSON.parse(fs.readFileSync(fixturePath(), 'utf8')) as readonly ToolParitySnapshot[];
}

// Only write when run directly, so `check:parity` can import the capture without regenerating it.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const snapshot = captureBaseImageToolParity();
  fs.mkdirSync(path.dirname(fixturePath()), { recursive: true });
  fs.writeFileSync(fixturePath(), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  console.log(`generate-tool-parity-fixture: wrote ${fixturePath()}`);
  for (const s of snapshot) console.log(`generate-tool-parity-fixture: profile '${s.profile}' — ${s.tools.length} tool(s) visible`);
}
