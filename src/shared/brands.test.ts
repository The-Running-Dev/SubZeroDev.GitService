import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloneUrl, credentialRef, declarationId, generation, grantEpoch, pathPrefix, repoRelativePath } from './brands.ts';
import type { RemoteHost } from './brands.ts';

/**
 * Counted accept/reject fixtures, per `agent.md` § Verification ("a
 * validator that has never failed is not known to constrain anything") and
 * the same self-test shape `scripts/build-registry.ts` already uses for the
 * compiler. S5's own acceptance criterion for `declarationId()` and
 * `cloneUrl()` explicitly asks for "positive and negative counts stated".
 */
function runFixtures<T>(name: string, fixtures: readonly { readonly input: T; readonly expectOk: boolean }[], validate: (input: T) => { readonly ok: boolean }) {
  let accepted = 0;
  let rejected = 0;
  for (const fixture of fixtures) {
    const result = validate(fixture.input);
    assert.equal(result.ok, fixture.expectOk, `${name}: ${JSON.stringify(fixture.input)} expected ok=${fixture.expectOk}, got ok=${result.ok}`);
    if (result.ok) accepted += 1;
    else rejected += 1;
  }
  return { accepted, rejected };
}

test('declarationId() accepts and rejects per ^[a-z0-9][a-z0-9-]{0,62}$, counted', () => {
  const fixtures = [
    { input: 'blog', expectOk: true },
    { input: 'my-repo-2', expectOk: true },
    { input: 'a', expectOk: true },
    { input: '0-start', expectOk: true },
    { input: 'a'.repeat(63), expectOk: true },
    { input: '', expectOk: false },
    { input: '-leading-dash', expectOk: false },
    { input: 'Has-Upper', expectOk: false },
    { input: 'has_underscore', expectOk: false },
    { input: 'has space', expectOk: false },
    { input: 'a'.repeat(64), expectOk: false },
    { input: 'trailing/', expectOk: false },
  ];
  const { accepted, rejected } = runFixtures('declarationId', fixtures, declarationId);
  assert.equal(accepted, 5);
  assert.equal(rejected, 7);
});

test('cloneUrl() accepts hosts on the allowlist and rejects everything else, counted', () => {
  const allowed: readonly RemoteHost[] = ['github.com' as RemoteHost, 'gitlab.example.com' as RemoteHost];
  const fixtures = [
    { input: 'https://github.com/owner/repo.git', expectOk: true },
    { input: 'https://GitHub.com/owner/repo.git', expectOk: true }, // host comparison is case-insensitive
    { input: 'git@github.com:owner/repo.git', expectOk: true }, // scp-style
    { input: 'https://gitlab.example.com/group/project.git', expectOk: true },
    { input: 'https://attacker.example/owner/repo.git', expectOk: false },
    { input: 'git@attacker.example:owner/repo.git', expectOk: false },
    { input: 'ftp://github.com/owner/repo.git', expectOk: false },
    { input: 'not a url at all', expectOk: false },
    { input: '', expectOk: false },
  ];
  const { accepted, rejected } = runFixtures('cloneUrl', fixtures, (input: string) => cloneUrl(input, allowed));
  assert.equal(accepted, 4);
  assert.equal(rejected, 5);
});

test('generation() requires an integer >= 1', () => {
  assert.equal(generation(1).ok, true);
  assert.equal(generation(2).ok, true);
  assert.equal(generation(0).ok, false);
  assert.equal(generation(-1).ok, false);
  assert.equal(generation(1.5).ok, false);
});

test('grantEpoch() requires an integer >= 0', () => {
  assert.equal(grantEpoch(0).ok, true);
  assert.equal(grantEpoch(5).ok, true);
  assert.equal(grantEpoch(-1).ok, false);
  assert.equal(grantEpoch(1.5).ok, false);
});

test('credentialRef() matches ^[a-z0-9][a-z0-9._-]{0,63}$', () => {
  assert.equal(credentialRef('github-pat').ok, true);
  assert.equal(credentialRef('a.b_c-1').ok, true);
  assert.equal(credentialRef('_leading-underscore').ok, false); // reserved for the TOTP sealing key, never a valid ref
  assert.equal(credentialRef('Has-Upper').ok, false);
  assert.equal(credentialRef('').ok, false);
});

test('repoRelativePath() rejects the same forms validateWritePath must map to malformed', () => {
  assert.equal(repoRelativePath('src/index.ts').ok, true);
  assert.equal(repoRelativePath('-A').ok, false);
  assert.equal(repoRelativePath('--all').ok, false);
  assert.equal(repoRelativePath('.').ok, false);
  assert.equal(repoRelativePath('../escape').ok, false);
  assert.equal(repoRelativePath('a/../b').ok, false);
  assert.equal(repoRelativePath('a;b').ok, false);
  assert.equal(repoRelativePath('/absolute').ok, false);
  assert.equal(repoRelativePath('').ok, false);
});

test('pathPrefix() accepts a directory prefix or a single file, both as valid RepoRelativePaths', () => {
  assert.equal(pathPrefix('src/').ok, true);
  assert.equal(pathPrefix('README.md').ok, true);
  assert.equal(pathPrefix('../escape/').ok, false);
});
