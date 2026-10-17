import type { Ask, Decision, Workstream } from "@fleetd/contracts";
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
 * The human digest: plain text, phone width (DESIGN §4). Facts only from state; a workstream's own status is
 * marked "lead says", since no check backs it until M6.
 */
export const renderHumanDigest = (input: DigestInput): string => {
  const project = (ref: Ask["projectRef"]) => input.projectNames.get(projectKey(ref)) ?? ref.projectId;
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
    let line = `${label} [${ask.kind === "do" ? "do" : ask.class}] ${project(ask.projectRef)}: ${clip(ask.text)}`;
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
  for (const w of done) lines.push(`Done: ${status(w)} (lead says; not checked yet)`);
  for (const w of failed) lines.push(`Failed: ${status(w)}${says(w)}`);

  if (input.decidedWithoutYou.length > 0) {
    const shown = input.decidedWithoutYou.slice(0, DECIDED_MAX);
    const list = shown.map((d) => `${d.key}=${clip(d.value, 40)} (${d.decisionId})`).join("; ");
    lines.push(
      `Decided without you (${input.decidedWithoutYou.length}): ${list} · reply "forget ${shown[0]!.decisionId}" to undo one`,
    );
  }
  for (const w of running) lines.push(`Running: ${status(w)}${says(w)}`);
  return lines.join("\n");
};
