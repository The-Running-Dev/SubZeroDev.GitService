import type { Journal } from "../journal.ts";

/**
 * The journal for a test pipeline composed only for read-only, wait or
 * file-watcher calls. `DispatchPipelineDependencies.journal` is required (S61)
 * and none of those calls reach it, so any call here is a test reaching a path
 * it did not intend, and it throws rather than recording anything.
 */
export function inertJournal(): Pick<
  Journal,
  "begin" | "markApplied" | "settle" | "park"
> {
  const unexpected = (method: string) => async (): Promise<never> => {
    throw new Error(
      `inertJournal.${method} was called: this test pipeline was composed for calls that never journal`,
    );
  };
  return {
    begin: unexpected("begin"),
    markApplied: unexpected("markApplied"),
    settle: unexpected("settle"),
    park: unexpected("park"),
  };
}
