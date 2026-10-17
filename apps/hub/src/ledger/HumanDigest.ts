import { PLAYBOOK_ASK_PREFIX, type Ask, type Decision, type Workstream, type WorkstreamId } from "@fleetd/contracts";
import type { WorkstreamFacts } from "../leads/digest.ts";
import { FINISH_ALL_IDLE, isFinishAll } from "../playbooks/finishAllRules.ts";
import { batchN, projectKey } from "./LedgerRepo.ts";

/** What the 09:00/18:00 digest is rendered from; the caller gathers it. */
export interface DigestInput {
  readonly nowMs: number;
  /** IANA zone from `policy.tz`; an unknown zone falls back to UTC. */
  readonly tz: string;
  /** Open asks. */
  readonly asks: ReadonlyArray<Ask>;
  /** Workstreams worth a line: live ones, plus those that finished or failed since the last digest. */
  readonly workstreams: ReadonlyArray<Workstream>;
  /** Lead decisions since the last digest, newest first. */
  readonly decidedWithoutYou: ReadonlyArray<Decision>;
  /** Display names by `machineId/projectId`; the project id is used when missing. */
  readonly projectNames: ReadonlyMap<string, string>;
  /** Checks passed and ETAs, as fleetd measured them; absent ones show none. */
  readonly facts?: ReadonlyMap<WorkstreamId, WorkstreamFacts>;
  /** Lines from `humanTrainLines`: merges since the last digest and the state of each train. */
  readonly train?: ReadonlyArray<string>;
  /** M12: the retro's advise-only proposals, from `suggestedLines`. */
  readonly suggested?: ReadonlyArray<string>;
}

const DECIDED_MAX = 5;
const TEXT_MAX = 120;

const RUNNING = new Set<Workstream["state"]>(["draft", "running", "converging", "verifying"]);

const clip = (text: string, max = TEXT_MAX) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const when = (nowMs: number, tz: string) => {
  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  };
  try {
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: tz }).format(nowMs);
  } catch {
    return `${new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" }).format(nowMs)} UTC`;
  }
};

/**
 * The human digest: plain text, phone width (DESIGN §4). Facts only from state: ✓ marks checks fleetd ran and saw
 * pass, and a workstream's own status line is marked "lead says", since nothing backs it.
 */
export const renderHumanDigest = (input: DigestInput): string => {
  const project = (ref: Ask["projectRef"]) => (ref === undefined ? "unrouted" : (input.projectNames.get(projectKey(ref)) ?? ref.projectId));
  const askProject = (ask: Ask) => (ask.projectRef === undefined && ask.key.startsWith(PLAYBOOK_ASK_PREFIX) ? "playbooks" : project(ask.projectRef));
  const open = input.asks.filter((ask) => ask.state === "open");
  const latest = Math.max(0, ...open.map((ask) => (ask.batchId ? batchN(ask.batchId)! : 0)));
  const running = input.workstreams.filter((w) => RUNNING.has(w.state));
  const done = input.workstreams.filter((w) => w.state === "done");
  const failed = input.workstreams.filter((w) => w.state === "failed");

  const lines: Array<string> = [`fleetd digest · ${when(input.nowMs, input.tz)}`];
  const counts = [`${running.length} running`, `${done.length} done`, ...(failed.length > 0 ? [`${failed.length} failed`] : [])];
  lines.push(
    [open.length === 0 ? "Nothing needs you" : `${latest > 0 ? `B${latest} · ` : ""}${open.length} need you`, ...counts].join(" · "),
  );

  const ordered = [...open].sort(
    (a, b) =>
      (a.batchId ? batchN(a.batchId)! : Infinity) - (b.batchId ? batchN(b.batchId)! : Infinity) ||
      (a.number ?? 0) - (b.number ?? 0),
  );
  for (const ask of ordered) {
    const n = ask.batchId ? batchN(ask.batchId)! : undefined;
    const label = n === undefined ? ask.askId : n === latest ? `${ask.number}` : `#B${n} ${ask.number}`;
    let line = `${label} [${ask.kind === "do" ? "do" : ask.class}] ${askProject(ask)}: ${clip(ask.text)}`;
    if (ask.kind === "do") {
      const steps = ask.steps?.length ?? 0;
      line += ` (${steps} step${steps === 1 ? "" : "s"}; reply "${ask.number ?? ask.askId} done" when finished)`;
    } else {
      if (ask.options && ask.options.length > 0) {
        line += ` ${ask.options.map((option, i) => `${"abcdef"[i]}) ${clip(option, 40)}`).join(" ")}`;
      }
      if (ask.recommendation !== undefined) line += ` rec: ${clip(ask.recommendation, 60)}`;
      if (ask.proceededOnRec) line += " (proceeded) — override?";
    }
    if (ask.blocks !== "nothing") line += `   (blocks: ${clip(ask.blocks, 60)})`;
    lines.push(line);
  }

  const status = (w: Workstream) => `${w.workstreamId} ${project(w.projectRef)}: ${clip(w.title || w.source.text, 60)}`;
  const says = (w: Workstream) => (w.headline ? ` — lead says: ${clip(w.headline, 80)}` : "");
  const checked = (w: Workstream) => {
    const total = w.brief?.doneWhen.length ?? 0;
    const passed = input.facts?.get(w.workstreamId)?.passed.size ?? 0;
    return total === 0 || passed === 0 ? "" : ` · ✓ ${passed} of ${total} checks`;
  };
  const eta = (w: Workstream) => {
    const text = input.facts?.get(w.workstreamId)?.eta;
    return text === undefined ? "" : ` · ${text}`;
  };
  // Only a passing claim makes a workstream done, so done ones are checked by definition.
  for (const w of done) lines.push(`Done: ${status(w)}${checked(w)}`);
  for (const w of failed) lines.push(`Failed: ${status(w)}${says(w)}`);

  if (input.decidedWithoutYou.length > 0) {
    const shown = input.decidedWithoutYou.slice(0, DECIDED_MAX);
    const list = shown.map((d) => `${d.key}=${clip(d.value, 40)} (${d.decisionId})`).join("; ");
    lines.push(
      `Decided without you (${input.decidedWithoutYou.length}): ${list} · reply "forget ${shown[0]!.decisionId}" to undo one`,
    );
  }
  for (const w of running) lines.push(`Running: ${status(w)}${says(w)}${checked(w)}${eta(w)}`);
  // Finish-all's finish line; other idle workstreams stay quiet.
  for (const w of input.workstreams.filter((w) => w.state === "idle" && isFinishAll(w))) lines.push(`Idle: ${status(w)} · ${FINISH_ALL_IDLE}`);
  lines.push(...(input.train ?? []));
  lines.push(...(input.suggested ?? []));
  return lines.join("\n");
};
