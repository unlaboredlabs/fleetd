// Settings › Bots › Bot › Computer, the parts with no React: a draft of the setup fields and the setup it saves, and the
// words for the computer image that setup builds. The hub checks the same rules (WorktreeSetup's schema); these only say
// so before a call.
import type { ComputerImage, WorktreeSetup } from "../../../shared/contracts";
import { age } from "../live/when";
import { fmtBytes } from "../time/format";

/** WorktreeSetup's most commands and input files. */
export const SETUP_COMMANDS_MAX = 20;
export const SETUP_INPUTS_MAX = 20;

/** The fields as typed: one command a line, one input file a line. */
export type SetupDraft = { readonly commands: string; readonly inputs: string };

export const draftOf = (setup: WorktreeSetup): SetupDraft => ({
  commands: (setup.commands ?? []).join("\n"),
  inputs: (setup.inputs ?? []).join("\n"),
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
  const inputs = [...new Set(lines(draft.inputs))];
  if (inputs.length > SETUP_INPUTS_MAX) return { ok: false, problem: `At most ${SETUP_INPUTS_MAX} files.` };
  const bad = inputs.map(inputProblem).find((p) => p !== null);
  if (bad !== undefined) return { ok: false, problem: bad };
  return { ok: true, setup: { commands, inputs } };
}

/** The draft saves something other than `setup`. */
export const changed = (draft: SetupDraft, setup: WorktreeSetup): boolean => {
  const next = setupFrom(draft);
  if (!next.ok) return true;
  const was = draftOf(setup);
  const same = (a: string, b: string) => lines(a).join("\n") === lines(b).join("\n");
  return !same(draft.commands, was.commands) || !same(draft.inputs, was.inputs);
};

/** The image row's line: its state now, in a few words, and whether it is a problem. */
export type ImageLine = { readonly text: string; readonly tone: "quiet" | "danger" };

const ago = (iso: string | undefined, nowMs: number): string | null => {
  const t = iso === undefined ? Number.NaN : Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const a = age(nowMs - t);
  return a === "<1m" ? "just now" : `${a} ago`;
};

/**
 * What the Image row says, or null when there is no row: no commands means no image (the hub says "none"), a machine
 * that can't build one (no VMs, no provider) says "none" with no `where`, and an older hub sends no image at all. A
 * building or failed image may still have an older one serving, built at `builtAt`.
 */
export function imageLine(image: ComputerImage | undefined, commands: number, nowMs: number): ImageLine | null {
  if (image === undefined || (image.state === "none" && (commands === 0 || image.where === undefined))) return null;
  const built = ago(image.builtAt, nowMs);
  const size = image.bytes === undefined ? null : fmtBytes(image.bytes);
  const last = built === null ? null : `last built ${built}`;
  if (image.state === "building") return { text: ["Building…", last].filter(Boolean).join(" · "), tone: "quiet" };
  if (image.state === "failed") {
    const failed = ago(image.failedAt, nowMs);
    return { text: [failed === null ? "Failed" : `Failed ${failed}`, last].filter(Boolean).join(" · "), tone: "danger" };
  }
  if (built === null) return { text: "Not built yet", tone: "quiet" };
  return { text: [`Built ${built}`, size].filter(Boolean).join(" · "), tone: "quiet" };
}

// Open: a newer hub may keep it somewhere this build has no words for.
const WHERE: Partial<Record<string, string>> = {
  vm: "a local VM image",
  boat: "a boat.dev snapshot",
  e2b: "an E2B snapshot",
  daytona: "a Daytona snapshot",
};

/** Where the image is kept, for the row's hover: "a local VM image". */
export const whereOf = (image: ComputerImage | undefined): string | null => (image?.where === undefined ? null : (WHERE[image.where] ?? null));
