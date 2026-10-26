// Settings → Projects → Setup commands, the parts with no React: a draft of the fields and the setup it saves. The hub
// checks the same rules (project_settings.rs WorktreeSetup); these only say so before a call.
import type { WorktreeSetup } from "../../../shared/contracts";

/** project_settings.rs SETUP_COMMANDS_MAX, SETUP_INPUTS_MAX, SETUP_TIMEOUT_DEFAULT_SEC and SETUP_TIMEOUT_MAX_SEC. */
export const SETUP_COMMANDS_MAX = 20;
export const SETUP_INPUTS_MAX = 20;
export const SETUP_TIMEOUT_DEFAULT_SEC = 600;
export const SETUP_TIMEOUT_MAX_SEC = 3600;

/** The fields as typed: one command a line, one input file a line. */
export type SetupDraft = { readonly commands: string; readonly timeout: string; readonly inputs: string; readonly runAnyway: boolean };

export const draftOf = (setup: WorktreeSetup): SetupDraft => ({
  commands: (setup.commands ?? []).join("\n"),
  timeout: String(setup.timeoutSec ?? SETUP_TIMEOUT_DEFAULT_SEC),
  inputs: (setup.inputs ?? []).join("\n"),
  runAnyway: setup.runAnyway ?? false,
});

const lines = (text: string): string[] =>
  text
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter((l) => l !== "");

/** project_settings.rs SetupInput: relative to the worktree, no empty, `.` or `..` segment. */
const inputProblem = (path: string): string | null => {
  if (path.length > 500) return `${path.slice(0, 40)}… is over 500 characters.`;
  if (path.startsWith("/")) return `${path} is absolute: name it from the top of the repo, as pnpm-lock.yaml.`;
  if (path.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return `${path} has an empty, . or .. part.`;
  return null;
};

export type SetupResult = { readonly ok: true; readonly setup: Required<WorktreeSetup> } | { readonly ok: false; readonly problem: string };

/** The setup the draft saves, or why it can't be saved. */
export function setupFrom(draft: SetupDraft): SetupResult {
  const commands = lines(draft.commands);
  if (commands.length > SETUP_COMMANDS_MAX) return { ok: false, problem: `At most ${SETUP_COMMANDS_MAX} commands.` };
  const long = commands.find((c) => c.length > 2000);
  if (long !== undefined) return { ok: false, problem: `${long.slice(0, 40)}… is over 2000 characters.` };
  const timeout = Number(draft.timeout.trim());
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > SETUP_TIMEOUT_MAX_SEC) {
    return { ok: false, problem: `The time limit is a whole number of seconds, 1 to ${SETUP_TIMEOUT_MAX_SEC}.` };
  }
  const inputs = [...new Set(lines(draft.inputs))];
  if (inputs.length > SETUP_INPUTS_MAX) return { ok: false, problem: `At most ${SETUP_INPUTS_MAX} files.` };
  const bad = inputs.map(inputProblem).find((p) => p !== null);
  if (bad !== undefined) return { ok: false, problem: bad };
  return { ok: true, setup: { commands, timeoutSec: timeout, runAnyway: draft.runAnyway, inputs } };
}

/** The draft saves something other than `setup`. */
export const changed = (draft: SetupDraft, setup: WorktreeSetup): boolean => {
  const next = setupFrom(draft);
  if (!next.ok) return true;
  const was = draftOf(setup);
  const same = (a: string, b: string) => lines(a).join("\n") === lines(b).join("\n");
  return !same(draft.commands, was.commands) || next.setup.timeoutSec !== Number(was.timeout) || !same(draft.inputs, was.inputs) || draft.runAnyway !== was.runAnyway;
};
