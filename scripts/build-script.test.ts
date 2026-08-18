import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * S29.3 (`30-slices.md` § S29): the layer-direction check runs inside
 * `npm run build`, the same build that already fails on the compiler-import
 * and migration checks — so removing it from the build script is a failure
 * here, not a silent gap discovered later in CI or in the image build.
 */

test('npm run build chains typecheck and every check:* gate, including check:layer-direction', () => {
  const packageJsonPath = path.resolve(import.meta.dirname, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const buildScript: string = pkg.scripts.build;
  const steps = buildScript.split('&&').map((step) => step.trim());

  assert.ok(steps.includes('npm run typecheck'), `build script missing typecheck: ${buildScript}`);
  assert.ok(steps.includes('npm run check:layering'), `build script missing check:layering: ${buildScript}`);
  assert.ok(steps.includes('npm run check:migration'), `build script missing check:migration: ${buildScript}`);
  assert.ok(steps.includes('npm run check:layer-direction'), `build script missing check:layer-direction: ${buildScript}`);
});
