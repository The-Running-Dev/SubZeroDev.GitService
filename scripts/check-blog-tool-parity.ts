import fs from 'node:fs';
import { compareToolParity, type ToolParitySnapshot } from '../src/contract/tool-parity.ts';
import { derivedFixturePath, legacyFixturePath } from './generate-blog-tool-parity-fixtures.ts';

/**
 * S20.8: compares the blog's legacy server (captured "before cutover", per
 * its own three capability tiers, relabelled onto GitService's four
 * `SessionKind`s per the mapping stated below) against the derived image's
 * capture (S20.7's compiled registry, per this service's own profiles).
 *
 * Every rename this migration makes (S20.3 — the ~26 tools that already had
 * a base equivalent, cut over to the base's name in the same change) is
 * named here, once, and reconciled before the raw compareToolParity() diff
 * is judged: a bare 'removed'+'added' pair for a stated rename is not a
 * loss, it is the rename working as intended. Anything left over after
 * reconciliation is a genuine, individually-named difference — an addition,
 * or a real loss for the user to see.
 */

// The mapping between blog-mcp's three capability tiers and GitService's
// four SessionKinds (S20.8's "mapping ... stated rather than assumed"),
// applied when the legacy fixture was captured
// (tools/blog-mcp/scripts/capture-legacy-tool-parity.mjs):
//   UI_CAPABILITIES    -> both 'operator' and 'mcp'
//   CRON_CAPABILITIES  -> 'scheduler'
//   WATCHER_CAPABILITIES -> 'watcher'

const RENAMES: ReadonlyMap<string, string> = new Map([
  ['blog_repo_status', 'repo_status'],
  ['blog_branches', 'git_branches'],
  ['blog_log', 'git_log'],
  ['blog_repo_health', 'repo_health'],
  ['blog_diff', 'git_diff'],
  ['blog_stage', 'git_stage'],
  ['blog_commit', 'git_commit'],
  ['blog_restore_paths', 'git_restore_paths'],
  ['blog_sync_base', 'sync_base'],
  ['blog_prepare_publish_branch', 'prepare_branch'],
  ['blog_push', 'git_push'],
  ['blog_create_pr', 'pr_open'],
  ['blog_auto_merge', 'pr_enable_auto_merge'],
  ['blog_reconcile_after_merge', 'reconcile_after_merge'],
  ['blog_pr_status', 'pr_status'],
  ['blog_list_prs', 'pr_list'],
  ['blog_pr_comments', 'pr_comments'],
  ['blog_check_status', 'checks_status'],
  ['blog_wait_for_checks', 'checks_await'],
  ['blog_verify_published_url', 'verify_published_url'],
  ['blog_schedule_publish', 'scheduled_job_create'],
  ['blog_list_scheduled_jobs', 'scheduled_job_list'],
  ['blog_cancel_scheduled_job', 'scheduled_job_cancel'],
  ['blog_list_posts', 'list_posts'],
  ['blog_get_post', 'get_post'],
  ['blog_list_tags', 'list_tags'],
  ['blog_list_authors', 'list_authors'],
  ['blog_parse_markdown', 'parse_markdown'],
  ['blog_validate_posts', 'validate_posts'],
  ['blog_validate_hubs', 'validate_hubs'],
  ['blog_run_doc_gate', 'run_doc_gate'],
  ['blog_run_artifact_check', 'run_artifact_check'],
  ['blog_preflight', 'preflight'],
  ['blog_create_post', 'create_post'],
  ['blog_update_post', 'update_post'],
  ['blog_delete_post', 'delete_post'],
  ['blog_add_tag', 'add_tag'],
  ['blog_add_author', 'add_author'],
  ['blog_add_hub_entry', 'add_hub_entry'],
  ['blog_reset_stage', 'unstage_paths'],
  ['blog_wait_for_merge', 'wait_for_merge'],
  ['blog_deploy_status', 'deploy_status'],
  ['blog_wait_for_deploy', 'wait_for_deploy'],
  ['blog_publish_report', 'publish_report'],
]);

// blog_create_branch has no 1:1 rename -- its function is subsumed into
// prepare_branch's composite (fetch + fresh-base + preserve local commits).
// Named individually below as a genuine, deliberate removal, not silently
// dropped.
const SUBSUMED = new Set(['blog_create_branch']);

function loadFixture(path: string): readonly ToolParitySnapshot[] {
  return JSON.parse(fs.readFileSync(path, 'utf8')) as readonly ToolParitySnapshot[];
}

const legacy = loadFixture(legacyFixturePath());
const derived = loadFixture(derivedFixturePath());

const raw = compareToolParity(legacy, derived);

const reconciledRenames: { profile: string; from: string; to: string }[] = [];
const subsumed: { profile: string; tool: string }[] = [];
const realDifferences = raw.differences.filter((d) => {
  if (d.kind === 'removed' && RENAMES.has(d.tool)) {
    const renamedTo = RENAMES.get(d.tool)!;
    const wasAdded = raw.differences.some((other) => other.profile === d.profile && other.kind === 'added' && other.tool === renamedTo);
    if (wasAdded) {
      reconciledRenames.push({ profile: d.profile, from: d.tool, to: renamedTo });
      return false;
    }
  }
  if (d.kind === 'added' && [...RENAMES.values()].includes(d.tool)) {
    const from = [...RENAMES.entries()].find(([, to]) => to === d.tool)?.[0];
    if (from && raw.differences.some((other) => other.profile === d.profile && other.kind === 'removed' && other.tool === from)) {
      return false; // the other half of a reconciled rename pair, already recorded above
    }
  }
  if (d.kind === 'removed' && SUBSUMED.has(d.tool)) {
    subsumed.push({ profile: d.profile, tool: d.tool });
    return false;
  }
  return true;
});

console.log(`check-blog-tool-parity: ${reconciledRenames.length} rename(s) reconciled (S20.3 cutover, expected):`);
for (const r of reconciledRenames) console.log(`  [${r.profile}] '${r.from}' -> '${r.to}'`);

console.log(`check-blog-tool-parity: ${subsumed.length} subsumed tool(s) (named, deliberate — folded into a composite):`);
for (const s of subsumed) console.log(`  [${s.profile}] '${s.tool}' -> folded into 'prepare_branch'`);

const byKind = { removed: 0, added: 0, 'capabilities-changed': 0, 'input-changed': 0 };
for (const d of realDifferences) byKind[d.kind] += 1;
console.log(`check-blog-tool-parity: remaining after reconciliation — removed: ${byKind.removed}, capabilities-changed: ${byKind['capabilities-changed']}, input-changed: ${byKind['input-changed']}, added: ${byKind.added}`);
for (const d of realDifferences) console.log(`check-blog-tool-parity: ${d.kind} [${d.profile}]: ${d.detail}`);

const failed = realDifferences.some((d) => d.kind !== 'added');
if (failed) {
  console.error(`check-blog-tool-parity: ${realDifferences.filter((d) => d.kind !== 'added').length} unexplained loss(es) or change(s) after reconciliation.`);
  process.exit(1);
}
console.log('check-blog-tool-parity: OK — every remaining difference is an addition; every removal is a stated rename or a named, deliberate subsumption.');
