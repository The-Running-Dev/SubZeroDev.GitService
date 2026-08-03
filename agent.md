# Agent — lessons learned

Retrospective notes for whoever (human or agent) works this repo next. Standing
*instructions* live in [`AGENTS.md`](AGENTS.md); *decisions* live in
`design/90-decisions.md`. This file is what was learned the hard way.

Keep it short — it loads into context, so length is a recurring cost. **Add a lesson only
when it would have changed a decision.** A lesson with no cost attached is a preference,
and preferences belong in `AGENTS.md`.

> **Everything below is inherited, not earned here.** It was harvested from ten existing
> projects because these are the failures most likely to repeat, not because they have
> already bitten in this repo. Delete any that turn out not to apply; add the ones that
> actually cost something. A lesson kept past its usefulness is context you pay for on
> every session.

---

## Drift

- **Editing from a diff accumulates drift that only a full read catches.** After many small
  edits, or at a phase boundary, reread the complete affected document set. One full-read
  pass over a spec set found twelve inconsistencies, including a functional bug where a
  derived-path list omitted a field, making one section's behaviour impossible under
  another's rules.
- **Search the concept, not the phrasing you just edited.** Striking a requirement from
  seven places, a grep for the exact removed phrase returned clean — it could not match the
  same requirement worded differently, and six stale statements survived a check reported as
  thorough. A pattern built from the text you changed confirms your edits instead of finding
  your misses. **Removals are where this bites**: a bad edit contradicts something visibly,
  a missed removal is silent.
- **When a document states a number, count the list.** "All eight operations" against a
  nine-row table survived two full review passes; the same defect occurred three times in
  one project, and four documents once carried four different counts of the same thing, all
  written from memory. Re-count; never increment.
- **When a type or public behaviour changes, audit everything downstream of it** — the prose
  description, every example, the projection or serialised form, the generated
  representation, command help, the test list, and the troubleshooting page. The pair of
  documents where one is an implementation-of the other is where drift concentrates.
- **A stale cross-reference is invisible.** Section numbers cited across documents rot
  silently when a document is restructured. Positional numbering makes this worse: inserting
  a document between existing ones means renumbering everything after it and rewriting every
  link. **Prefer appending.**

## Verification

- **Check documentation against the tree, not against other documentation.** A page once
  described a file that had never existed in git history, and a threshold table drifted the
  same way — both had been checked against neighbouring docs, which agreed with them.
- **Pull the real artifact before reasoning about it.** Merging two build outputs raised one
  real question — do their asset folders collide? Guessing wrong would have silently
  overwritten one build's output with the other's. Pulling the image and running the actual
  build answered it in two commands.
- **Running the code beats recalling it.** A golden-test vector written from memory was
  wrong; executing the reference implementation caught it before it became the expected
  value everything else was checked against.
- **Several confident recollections were wrong.** Every claim about an external contract
  should be checked against the published spec, not remembered.
- **An OS resource whose lifetime must equal the process's needs a strong reference from
  module scope.** The instance lease kept its lock handle reachable only through the object
  `acquire` returned. Every test passed; a real holder that idled for a fifth of a second
  lost the lock while alive and healthy, and a second process was granted the same volume.
  Cost about forty minutes to bisect, and it would otherwise have shipped silent dual
  ownership — the exact failure the lease exists to prevent. **Exercise a long-lived holder
  with an idle process, not a short-lived one**, or the bug cannot appear: a process that
  exits promptly never gives the runtime a chance to collect anything.
- **On this host, make temp-directory cleanup best-effort.** Six store tests reported red
  for an `EPERM` in `rmSync` while every assertion in them had passed — Windows refuses to
  unlink a file with an open handle, and SQLite does not always release on `close()`. Cost a
  full rewrite of the test file to discover that the failures were cleanup, not behaviour.
- **`void somethingAsync()` discards the rejection path.** Converting a `.then/.catch` chain
  to `async/await` inside a `void`-invoked handler silently deleted the `.catch`, and
  nothing failed, because no test made the handler throw. It would have shipped a remote
  process-crash reachable by an authenticated health check — on the exact failure the design
  says must never be fatal. The `void fn()` call site is the checkable tell: it throws the
  promise away, so every rejection inside must already be handled. Found by `/reconcile`,
  not by the tests that were passing.
- **Do not verify long-lived servers by backgrounding them from Git Bash on this host.**
  `kill %1` and `$!` do not reliably reach the grandchild, so servers outlive the script.
  Cost a two-minute command timeout and a scatter of orphaned `node` processes that could
  not be safely reaped — twice, in S2 and again in S3. Drive multi-process scenarios from
  `node:test` with Node's own child-process APIs, where every such check already passes.

## Token economy

- **Skill and command prompts inject their whole instruction file** on invocation. Only
  invoke one you will actually use.
- **Prefer targeted search and offset reads for routine work**; a large spec can cost 30K
  tokens per full read. Full reads are for the drift pass, not for lookups.
- **Start a fresh session at phase boundaries.** `AGENTS.md`, this file, and the design docs
  re-prime a new session cheaply — which is the reason for keeping all three tight.
- **Knowledge-graph tooling is cheap on code and expensive on prose.** Code extracts
  structurally via AST with no model call; prose does not, and a full rebuild on a small
  prose corpus cost ~200K tokens and found fewer issues than reading the documents did.

## Git, CI, and delivery

- **`prettier --check` reports false failures on a Windows working tree.** `core.autocrlf=true`
  gives CRLF locally while the committed blob is LF, which is what CI checks out. Check the
  blob before "fixing" formatting CI never complained about.
- **After a squash merge, `git branch -d` reports the branch unmerged** because the squash
  commit shares no history with it. Confirm with `git diff <branch> main` returning empty,
  then delete.
- **A required status check that never runs blocks the pull request permanently.** The
  saving on a skipped run is not worth a check that silently never reports — think twice
  before adding a `paths:` filter to a required workflow.
- **A CI job can never be granted more permission than its workflow declares.** Splitting a
  read-only gate from a deploy that needs write credentials is what keeps the gate from
  holding credentials it never uses.

## Rendering and encoding

- **A diff cannot show a rendering bug.** Documents shipped for months with metadata fields
  merged into one run-on paragraph, because Markdown joins consecutive lines — correct
  Markdown, wrong intent. A metadata field or blockquote label needs a **blank line** after
  it, never trailing double-spaces (`git diff --check` rejects those). Render before merging
  a document change.

## Naming and scope

- **Name things after structure, not flavour.** A kind was nearly named for its genre, which
  would have licensed a new one per theme. Theme words smuggle in decisions.
- **When a document starts describing how something *works* rather than what it *contains*,
  stop and check the contract it depends on.** An eight-document draft accidentally wrote a
  parallel engine — its own state envelope, its own API, its own status union. Six of its
  eight operations already existed upstream under different names. Every individual
  paragraph read like reasonable design; it was only visible when each claim was checked
  against the actual contract.
- **A shortcut taken in the reference implementation gets copied.** The next author reads
  the working example before reading the contract.
