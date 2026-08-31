import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * Two rules, both from `10-design.md` § *Module boundaries*, whose table
 * (`L5 Surfaces` / `L4 Runtime` / `L3 Adapters` / `L2 Domain` / `L1 Platform`
 * / `L0 Contract`) fixes which top-level `src/` directory is which layer.
 * This walks the real module graph and fails on any edge either rule forbids.
 *
 * **B1, the product rule** (`20-contract.md` § Boundaries): nothing in L0,
 * L3, L4 or L5 imports anything from L2. The runtime is generic and the git
 * domain is a consumer of it; that seam stops being cuttable the first time
 * the dispatch pipeline knows what a branch is.
 *
 * **The direction rule**: "Dependencies point downward only." Enforced here
 * as *no upward **value** import at any layer* — a runtime edge from a lower
 * layer to a higher one. Type-only upward edges are real and necessary: a
 * module that receives a collaborator by injection (**B2** — the scheduler,
 * the watcher and the lifecycle module all do) cannot type that collaborator
 * without importing its interface, and the import erases at compile time.
 * They are therefore *listed*, in `ALLOWED_UPWARD_TYPE_EDGES` below, with the
 * reason each exists — so a new one, or one of these becoming a value import,
 * fails here rather than accruing. An allowance whose edge is gone is also
 * reported, so the list cannot rot into a description of the past.
 *
 * The direction rule was unenforced until this check grew it, and the cost
 * was visible: `src/contract/tool-parity.ts` value-imported `expandScopes`
 * from L4 `authorization`, making the module graph cyclic against **B2**
 * while this gate printed OK, because B1 only ever looked for edges into L2
 * (post-S36 reconciliation, `90-decisions.md`).
 *
 * Test files are excluded from the walk entirely: a test composing L0 and L2
 * together is exercising the seam on purpose, not violating the boundary the
 * seam sits behind.
 */

export type Layer = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

export const LAYER_BY_TOP_DIR: Readonly<Record<string, Layer>> = {
  contract: 'L0',
  declarations: 'L1',
  credentials: 'L1',
  clone: 'L1',
  exec: 'L1',
  locks: 'L1',
  lifecycle: 'L1',
  notifier: 'L1',
  audit: 'L1',
  journal: 'L1',
  store: 'L1',
  recovery: 'L1',
  git: 'L2',
  composites: 'L2',
  host: 'L2',
  scheduler: 'L2',
  watcher: 'L2',
  'module-adapter': 'L3',
  http: 'L3',
  dispatch: 'L4',
  authorization: 'L4',
  'operator-identity': 'L4',
  surfaces: 'L5',
  'mcp-proxy': 'L5',
};

/**
 * The composition root's top-level entries. They carry no layer — the root
 * wires every layer together by construction — but that is not itself the
 * exemption: every file under them must additionally be named in
 * `EXEMPT_PATHS` below.
 */
export const COMPOSITION_ROOT_TOP_ENTRIES: ReadonlySet<string> = new Set(['server.ts', 'composition-root']);

/**
 * Cross-cutting primitives with no layer of their own: branded types,
 * `Outcome`, the result envelope, the clock. Depended on from everywhere, and
 * every edge out of them into a layered module is type-only — which this
 * check verifies rather than assumes (`primitiveValueViolations` below).
 * An earlier version of this comment claimed they depend on nothing, which
 * was false: `shared/session.ts` and `shared/call-context.ts` reach L0 and
 * L1, and `result/envelope.ts` reaches L0 and L1. Because those edges are
 * type-only, no *runtime* edge through a primitive can violate a direction,
 * which is the property the exemption actually needs. Giving them invented
 * layers was rejected on 2026-08-14 and stays rejected.
 */
export const PRIMITIVE_TOP_ENTRIES: ReadonlySet<string> = new Set(['shared', 'result', 'clock']);

/**
 * Top-level `src/` entries that carry no layer, each for a stated reason.
 * Together with `LAYER_BY_TOP_DIR` this must cover every entry under `src/`,
 * and the walk below fails when it does not — otherwise the gate's coverage
 * is invisible: an unlisted directory was silently skipped, so renaming
 * `src/surfaces`, or adding a new L4 or L5 directory, disabled B1 for it
 * while the run still printed OK (review of PR #112). Being made to classify
 * a new directory here is the point, not friction.
 */
export const UNLAYERED_TOP_ENTRIES: ReadonlySet<string> = new Set([...COMPOSITION_ROOT_TOP_ENTRIES, ...PRIMITIVE_TOP_ENTRIES]);

/**
 * The exemption, **by file path** rather than by directory. `10-design.md`
 * § *Module boundaries* gives the reason the granularity matters: "the
 * exemption is by path, so widening it is a visible diff rather than a
 * habit." Exempting `src/composition-root/` as a directory let a new file
 * under it inherit the exemption with no diff here at all, which is the
 * habit that sentence exists to prevent (post-S36 reconciliation).
 *
 * `server.ts` is listed although it imports no L2 today — it is the program
 * entry point and may legitimately reach anything; dropping it would make
 * the list describe the current import graph rather than the root.
 */
export const EXEMPT_PATHS: readonly string[] = ['server.ts', 'composition-root/compose.ts', 'composition-root/production-declarations.ts'];

/**
 * Every type-only upward edge in the graph, with the reason it exists. Two
 * kinds, and no third has been accepted:
 *
 * - **injected collaborator** — the importing module receives this
 *   collaborator at composition time (**B2**) and imports its interface only
 *   to type the injection point. The import erases; no runtime edge exists.
 * - **shared shape** — a type whose home is above its consumer. Each is a
 *   plain data shape, never a module interface, and each is a candidate for
 *   moving down into `shared/` rather than being kept here forever.
 *
 * A value import is never allowed here, whichever kind it claims to be.
 */
export interface UpwardTypeEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: 'injected collaborator' | 'shared shape';
  readonly why: string;
}

export const ALLOWED_UPWARD_TYPE_EDGES: readonly UpwardTypeEdge[] = [
  { from: 'audit/types.ts', to: 'host/types.ts', kind: 'shared shape', why: '`PullRequestRef` on an audit record body' },
  { from: 'journal/types.ts', to: 'host/types.ts', kind: 'shared shape', why: '`PullRequestRef` on a journal step' },
  { from: 'contract/tool-parity.ts', to: 'declarations/types.ts', kind: 'shared shape', why: '`SessionKind` — the profile set parity is captured over' },
  { from: 'lifecycle/boot.ts', to: 'authorization/authorization.ts', kind: 'injected collaborator', why: 'boot is handed every collaborator' },
  { from: 'lifecycle/boot.ts', to: 'operator-identity/operator-identity.ts', kind: 'injected collaborator', why: 'boot is handed every collaborator' },
  { from: 'lifecycle/boot.ts', to: 'scheduler/scheduler.ts', kind: 'injected collaborator', why: 'boot is handed every collaborator' },
  { from: 'lifecycle/boot.ts', to: 'scheduler/types.ts', kind: 'shared shape', why: '`BootJobReport`, composed from the scheduler\'s own types (`20-contract.md` § L1 — lifecycle)' },
  { from: 'lifecycle/boot.ts', to: 'watcher/watcher.ts', kind: 'injected collaborator', why: 'boot is handed every collaborator' },
  { from: 'lifecycle/recovery.ts', to: 'dispatch/dispatch-pipeline.ts', kind: 'injected collaborator', why: 'a resume step runs as an ordinary dispatch (**R8**)' },
  { from: 'scheduler/scheduler.ts', to: 'authorization/authorization.ts', kind: 'injected collaborator', why: '`grantIsLive` at fire time' },
  { from: 'scheduler/scheduler.ts', to: 'dispatch/dispatch-pipeline.ts', kind: 'injected collaborator', why: '`Dispatch`, injected — never imported as a value (**B2**)' },
  { from: 'watcher/watcher.ts', to: 'dispatch/dispatch-pipeline.ts', kind: 'injected collaborator', why: '`Dispatch`, injected — never imported as a value (**B2**)' },
];

const LAYER_RANK: Readonly<Record<Layer, number>> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4, L5: 5 };

function normalise(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, '/');
}

function layerOf(srcRoot: string, filePath: string): Layer | null {
  const relative = path.relative(srcRoot, filePath);
  const topDir = relative.split(path.sep)[0] ?? '';
  return LAYER_BY_TOP_DIR[topDir] ?? null;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
}

export interface LayerDirectionResult {
  /** Top-level `src/` entries that are neither layered nor explicitly unlayered. */
  unclassified: string[];
  /** One line per L0/L3/L4/L5 module that imports an L2 module. */
  violations: string[];
  /** One line per file under a composition-root entry that is not named in `exemptPaths`. */
  unexemptedRootFiles: string[];
  /** One line per **value** import from a lower layer to a higher one. */
  upwardValueViolations: string[];
  /** One line per type-only upward edge absent from `ALLOWED_UPWARD_TYPE_EDGES`. */
  unlistedUpwardTypeEdges: string[];
  /** One line per allowance whose source file still exists but whose edge is gone. */
  staleAllowances: string[];
  /** One line per **value** import from an unlayered primitive into a layered module. */
  primitiveValueViolations: string[];
  /** Count of L0/L3/L4/L5 modules the walk actually inspected for B1. */
  checkedFiles: number;
  /** Count of all non-test `.ts` files walked under `srcRoot`. */
  totalFiles: number;
}

/** One import edge, as the walk sees it. */
interface Edge {
  readonly fromRelative: string;
  readonly toRelative: string;
  readonly fromLayer: Layer | null;
  readonly toLayer: Layer | null;
  readonly typeOnly: boolean;
}

/**
 * True when the import contributes no runtime edge — `import type { ... }`,
 * or a named-import list in which every element carries its own `type`.
 * A default or namespace import is never type-only here.
 */
function isTypeOnlyImport(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(node)) return node.isTypeOnly;
  const clause = node.importClause;
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  if (clause.name === undefined && bindings !== undefined && ts.isNamedImports(bindings)) {
    return bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
  }
  return false;
}

function edgesOf(srcRoot: string, file: string): Edge[] {
  const sourceFile = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2023, true);
  const edges: Edge[] = [];
  sourceFile.forEachChild((node) => {
    if (!(ts.isImportDeclaration(node) || ts.isExportDeclaration(node))) return;
    if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) return;
    const specifier = node.moduleSpecifier.text;
    if (!specifier.startsWith('.')) return;
    const resolved = normalise(path.resolve(path.dirname(file), specifier));
    edges.push({
      fromRelative: path.relative(srcRoot, file).replace(/\\/g, '/'),
      toRelative: path.relative(srcRoot, resolved).replace(/\\/g, '/'),
      fromLayer: layerOf(srcRoot, file),
      toLayer: layerOf(srcRoot, resolved),
      typeOnly: isTypeOnlyImport(node),
    });
  });
  return edges;
}

function topEntryOf(relative: string): string {
  return relative.split('/')[0] ?? '';
}

/**
 * Walks `srcRoot` and reports every rule this gate enforces. `exemptPaths`
 * are compared by resolved file path, never by directory or by name — see
 * `EXEMPT_PATHS` for why the granularity is the point. A single string is
 * accepted for the fixture callers that name one root.
 */
export function checkLayerDirection(
  srcRoot: string,
  exemptPaths: string | readonly string[],
  allowedUpwardTypeEdges: readonly UpwardTypeEdge[] = ALLOWED_UPWARD_TYPE_EDGES,
): LayerDirectionResult {
  const unclassified = readdirSync(srcRoot).filter(
    (entry) => !(entry in LAYER_BY_TOP_DIR) && !UNLAYERED_TOP_ENTRIES.has(entry),
  );

  const files: string[] = [];
  walk(srcRoot, files);

  const exempt = new Set((typeof exemptPaths === 'string' ? [exemptPaths] : exemptPaths).map(normalise));
  const allowanceKeys = new Set(allowedUpwardTypeEdges.map((edge) => `${edge.from} -> ${edge.to}`));
  const seenAllowanceKeys = new Set<string>();

  const violations: string[] = [];
  const unexemptedRootFiles: string[] = [];
  const upwardValueViolations: string[] = [];
  const unlistedUpwardTypeEdges: string[] = [];
  const primitiveValueViolations: string[] = [];
  let checkedFiles = 0;

  for (const file of files) {
    const normalisedFile = normalise(file);
    const relative = path.relative(srcRoot, file).replace(/\\/g, '/');
    const topEntry = topEntryOf(relative);

    if (COMPOSITION_ROOT_TOP_ENTRIES.has(topEntry)) {
      // Not exempt by living here — exempt only by being named. This is what
      // makes widening the exemption a visible diff.
      if (!exempt.has(normalisedFile)) {
        unexemptedRootFiles.push(`${relative} is under the composition root but is not named in EXEMPT_PATHS`);
      }
      continue;
    }
    if (exempt.has(normalisedFile)) continue;

    const fromLayer = layerOf(srcRoot, file);
    const isPrimitive = PRIMITIVE_TOP_ENTRIES.has(topEntry);
    if (fromLayer === null && !isPrimitive) continue;

    // B1 counts only the layers `20-contract.md` names.
    if (fromLayer !== null && fromLayer !== 'L1' && fromLayer !== 'L2') checkedFiles += 1;

    for (const edge of edgesOf(srcRoot, file)) {
      if (edge.toLayer === null) continue;

      if (isPrimitive) {
        // A primitive carries no layer, so it has no direction to violate —
        // but a *value* edge out of one would put a runtime dependency behind
        // a module nothing direction-checks. That is the property the
        // exemption needs, so it is checked rather than assumed.
        if (!edge.typeOnly) {
          primitiveValueViolations.push(`${edge.fromRelative} (unlayered primitive) value-imports ${edge.toRelative} (${edge.toLayer})`);
        }
        continue;
      }
      if (fromLayer === null) continue;

      if (edge.toLayer === 'L2' && fromLayer !== 'L1' && fromLayer !== 'L2') {
        violations.push(`${edge.fromRelative} (${fromLayer}) imports ${edge.toRelative} (L2)`);
      }

      if (LAYER_RANK[fromLayer] < LAYER_RANK[edge.toLayer]) {
        const key = `${edge.fromRelative} -> ${edge.toRelative}`;
        if (!edge.typeOnly) {
          upwardValueViolations.push(`${edge.fromRelative} (${fromLayer}) value-imports ${edge.toRelative} (${edge.toLayer})`);
        } else if (allowanceKeys.has(key)) {
          seenAllowanceKeys.add(key);
        } else {
          unlistedUpwardTypeEdges.push(`${edge.fromRelative} (${fromLayer}) type-imports ${edge.toRelative} (${edge.toLayer})`);
        }
      }
    }
  }

  // An allowance whose source file is gone is not stale — the fixture trees
  // this function is also run against contain none of them. An allowance
  // whose source file is still here but whose edge is not has outlived the
  // thing it described, and saying so is what stops the list becoming a
  // record of the past.
  const staleAllowances = allowedUpwardTypeEdges
    .filter((edge) => !seenAllowanceKeys.has(`${edge.from} -> ${edge.to}`))
    .filter((edge) => existsSync(path.join(srcRoot, edge.from)))
    .map((edge) => `${edge.from} -> ${edge.to} is allowed here but no longer exists`);

  return {
    unclassified,
    violations,
    unexemptedRootFiles,
    upwardValueViolations,
    unlistedUpwardTypeEdges,
    staleAllowances,
    primitiveValueViolations,
    checkedFiles,
    totalFiles: files.length,
  };
}

// CLI entrypoint — only runs when this file is executed directly, not when
// imported by the test.
const isMain = process.argv[1] !== undefined && normalise(process.argv[1]) === normalise(fileURLToPath(import.meta.url));
if (isMain) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const srcRoot = path.join(repoRoot, 'src');

  const result = checkLayerDirection(srcRoot, EXEMPT_PATHS.map((relative) => path.join(srcRoot, relative)));

  let failed = false;
  function report(lines: readonly string[], headline: string, remedy: string): void {
    if (lines.length === 0) return;
    failed = true;
    console.error(`check-layer-direction: ${lines.length} ${headline}`);
    for (const line of lines) console.error(`  ${line}`);
    console.error(`  ${remedy}`);
  }

  report(
    result.unclassified.map((entry) => `src/${entry}`),
    'top-level src/ entr(y|ies) carry no layer, so nothing here is checked for them:',
    'Add each to LAYER_BY_TOP_DIR, or to PRIMITIVE_TOP_ENTRIES / COMPOSITION_ROOT_TOP_ENTRIES with the reason it has no layer.',
  );
  report(
    result.violations,
    'violation(s) of invariant B1 — L0/L3/L4/L5 importing L2:',
    'The runtime is generic and the git domain is a consumer of it. Reach the domain by a name resolved at startup, not a symbol resolved at compile time.',
  );
  report(
    result.unexemptedRootFiles,
    'composition-root file(s) not named in EXEMPT_PATHS:',
    'The exemption is by path, so widening it is a visible diff. Add the path deliberately, or move the file into a layer.',
  );
  report(
    result.upwardValueViolations,
    'upward **value** import(s) — a runtime edge from a lower layer to a higher one:',
    'Dependencies point downward only (10-design.md § Module boundaries). Move the value down to the layer that owns it, or receive it by injection and import only its type.',
  );
  report(
    result.primitiveValueViolations,
    'value import(s) out of an unlayered primitive into a layered module:',
    'A primitive is exempt from the direction rule because no runtime edge passes through it. Keep the import type-only, or give the value a layered home.',
  );
  report(
    result.unlistedUpwardTypeEdges,
    'type-only upward edge(s) not listed in ALLOWED_UPWARD_TYPE_EDGES:',
    'Add each with its kind and reason, or remove the edge. An unlisted one is how the direction rule erodes without a diff.',
  );
  report(
    result.staleAllowances,
    'entr(y|ies) in ALLOWED_UPWARD_TYPE_EDGES no longer describe a real edge:',
    'Delete each — an allowance list that outlives its edges is a description of the past.',
  );

  if (failed) process.exit(1);

  const injected = ALLOWED_UPWARD_TYPE_EDGES.filter((edge) => edge.kind === 'injected collaborator').length;
  console.log(
    `check-layer-direction: OK — ${result.checkedFiles} L0/L3/L4/L5 module(s) checked of ${result.totalFiles} walked, ` +
      `none imports L2; no upward value import at any layer; ` +
      `${ALLOWED_UPWARD_TYPE_EDGES.length} type-only upward edge(s) listed and all still present ` +
      `(${injected} injected collaborator, ${ALLOWED_UPWARD_TYPE_EDGES.length - injected} shared shape)`,
  );
}
