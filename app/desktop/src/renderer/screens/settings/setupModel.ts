// Settings › Bots › Bot › Computer, the parts with no React: a draft of the setup fields and the setup it saves, and the
// words for the computer image that setup builds. The hub checks the same rules (WorktreeSetup's schema); these only say
// so before a call.
import type { ComputerChoice, ComputerImage, ComputerPick, WorktreeSetup } from "../../../shared/contracts";
import { age } from "../live/when";
import { fmtBytes } from "../time/format";
import { sizeWord } from "../../../shared/billing";
import { FLEETD } from "../../../shared/provided";
import { hostedProvider, RUNNER_ID } from "../../../shared/providers";

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
 * that can't build one says "none" with no `where`, and a hub that builds none (a self-hosted one) sends no image. A
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
  boat: "a boat.dev snapshot",
};

/** Where the image is kept, for the row's hover: "a boat.dev snapshot". */
export const whereOf = (image: ComputerImage | undefined): string | null => (image?.where === undefined ? null : (WHERE[image.where] ?? null));

/** The pick's value in the Runs on select: AUTO for none, else `<kind>:<cpu>:<memGb>`. */
export const AUTO = "auto";
/**
 * Runs on's hover: the pick is where the agents the lead starts run, and the lead itself stays on the bot's machine
 * (`name`), or on the hosted sandboxes, in a box of its own: on a fleetd cloud team (`cloud`), fleetd's computers.
 */
export const runsOnHint = (machineId: string, name: string, cloud = false): string =>
  `Where the agents the lead starts run. The lead itself runs ${machineId !== RUNNER_ID ? `on ${name}` : cloud ? `on ${FLEETD}` : `in a ${hostedProvider().name} sandbox`}.`;

export const pickValue = (p: Pick<ComputerChoice, "kind" | "cpu" | "memGb"> | undefined): string => (p ? `${p.kind}:${p.cpu}:${p.memGb}` : AUTO);

/** Why options can't be used now, said once under the last of them, with the command that fixes it when there is one. */
export type PickNote = { why: string; fix?: string };

/** One option of the Runs on select: each real machine the bot may have, as the hub words it; one that can't be used
 * now is disabled and says why, never greyed out alone. Options side by side that can't for the same reason (a
 * provider's every size) say it once, as the last one's `note`. */
export type PickOption = { value: string; label: string; why?: string; pick?: ComputerPick; note?: PickNote };

/**
 * The Runs on select's options: Automatic (no pick: placed and sized as by default), then the hub's choices in its
 * order. Null when there is nothing to pick and nothing picked (a hub whose bots run on their machine, no provider
 * connected, or a hub too old to say): no row then. On a fleetd cloud team (`cloud`) every choice is one of fleetd's
 * computers, so each reads as its size alone ("4 CPU · 8 GB"), never its provider's name.
 */
export function pickOptions(settings: { computer?: ComputerPick; computers?: ComputerChoice[] }, cloud = false): PickOption[] | null {
  const choices = settings.computers;
  if (choices === undefined || (choices.length === 0 && settings.computer === undefined)) return null;
  return [
    { value: AUTO, label: "Automatic" },
    ...choices.map((c, i) => {
      const why = c.unavailable;
      const last = choices[i + 1]?.unavailable !== why;
      return {
        value: pickValue(c),
        label: cloud ? sizeWord(c) : c.label,
        ...(why ? { why } : {}),
        pick: { kind: c.kind, cpu: c.cpu, memGb: c.memGb },
        ...(why && last ? { note: { why, ...(c.fix ? { fix: c.fix } : {}) } } : {}),
      };
    }),
  ];
}
