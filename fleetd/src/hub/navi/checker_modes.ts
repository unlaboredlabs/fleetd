// The checker's model and effort, how many auto-approved actions a project keeps, and the mode a new project starts in
// (checker.ts stores and reads them).
import type { NaviApprovalMode } from "../../shared/contracts.ts";

export const CHECKER_MODEL = "claude-sonnet-5-5";
export const CHECKER_EFFORT = "medium";
export const AUTO_APPROVED_MAX = 200;
/**
 * What a project starts in (W588): nothing asks. Stored when it is made, by `startNew`; a project with no row, made
 * before that, still asks its checker.
 */
export const NEW_PROJECT_MODE: NaviApprovalMode = "yolo";
