import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compiler } from '../src/contract/compiler.ts';
import { captureToolParity, type ToolParitySnapshot } from '../src/contract/tool-parity.ts';
import { PRODUCTION_TOOL_DECLARATIONS } from '../src/composition-root/production-declarations.ts';
// Sibling checkout, per the 2026-08-21 decision log entry ("S20's derived-image
// build reaches the base's source via a sibling checkout and Docker's
// --build-context") — the same relative-import pattern extended the other
// direction: this script reaches into the blog's own extension declarations
// the way the blog's build reaches into this repo's src/.
import { EXTRA_TOOL_DECLARATIONS } from '../../SubZeroDev.Blog-S20/tools/git-service-consumer/declarations.ts';
import { EXTRA_GIT_UTILITY_DECLARATIONS } from '../../SubZeroDev.Blog-S20/tools/git-service-consumer/extra-declarations.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function derivedFixturePath(): string {
  return path.join(repoRoot, 'fixtures', 'tool-parity', 'blog-derived-image.json');
}

export function legacyFixturePath(): string {
  return path.join(repoRoot, 'fixtures', 'tool-parity', 'blog-legacy.json');
}

/**
 * S20.7/S20.8: recompiles the base's `PRODUCTION_TOOL_DECLARATIONS` unioned
 * with the blog's 20 extension declarations and captures S36's per-profile
 * snapshot from the result — the "after cutover" half of S20.8's
 * comparison, over the same four `SessionKind` profiles the base image's
 * own S36 fixture uses.
 */
export function captureBlogDerivedToolParity(): readonly ToolParitySnapshot[] {
  const declarations = [...PRODUCTION_TOOL_DECLARATIONS, ...EXTRA_TOOL_DECLARATIONS, ...EXTRA_GIT_UTILITY_DECLARATIONS];
  const result = compiler.compile(declarations);
  if (!result.ok) {
    throw new Error(`the blog's derived declaration set failed to compile (${result.error.length} error(s)): ${result.error.map((e) => e.code).join(', ')}`);
  }
  return captureToolParity(result.value.registry);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const snapshot = captureBlogDerivedToolParity();
  fs.mkdirSync(path.dirname(derivedFixturePath()), { recursive: true });
  fs.writeFileSync(derivedFixturePath(), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  console.log(`generate-blog-tool-parity-fixtures: wrote ${derivedFixturePath()}`);
  for (const s of snapshot) console.log(`generate-blog-tool-parity-fixtures: profile '${s.profile}' — ${s.tools.length} tool(s) visible`);
}
