import type { ToolDeclaration } from '../contract/tool-declaration.ts';

/**
 * The real, deployed tool inventory. Empty until U1 (`20-contract.md` §
 * Unresolved) is answered — S1 explicitly excludes declaring any product
 * tool (`30-slices.md` § S1, "Out of scope"). The first entries arrive in S6.
 */
export const PRODUCTION_TOOL_DECLARATIONS: readonly ToolDeclaration[] = [];
