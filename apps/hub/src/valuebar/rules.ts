// The value bar's spawn rules: writers say what they serve, a done workstream takes no more writes, and review stops
// after one clean pass per commit. Pure; ValueBar.ts feeds them the workstream, the PR head and its verdicts.
import { Schema } from "effect";
import { SERVES_FIX, Serves, type TaskKind, type Workstream } from "@fleetd/contracts";

export interface SpawnRequest {
  readonly workstreamId: Workstream["workstreamId"];
  readonly kind: TaskKind;
  readonly serves?: string;
  readonly pr?: string;
  readonly qa?: boolean;
}

/** A recorded verdict on one PR, newest first when listed. */
export interface PrVerdict {
  readonly taskId: string;
  readonly sha: string;
  readonly blocking: number;
}

export interface Refusal {
  readonly message: string;
  readonly fix?: string;
  /** Set when the refusal is a polish loop, which is also recorded as an incident with these lines. */
  readonly polishLoop?: ReadonlyArray<string>;
}

/** The hub spawning on its own behalf ("hub", "hub:judge"): its judge reviews criteria, not a PR. */
const isHubCaller = (by: string) => by === "hub" || by.startsWith("hub:");

const isServes = Schema.is(Serves);

/** Write spawns: the workstream is not done, `serves` is well formed, and `done:<n>` names an existing done-when check. */
export const writeRefusal = (request: SpawnRequest, workstream: Workstream): Refusal | undefined => {
  if (request.kind !== "write") return undefined;
  const id = workstream.workstreamId;
  if (workstream.state === "done") return { message: `${id} is done; open a new intent if there's more to do` };
  if (request.serves === undefined || !isServes(request.serves)) {
    return { message: request.serves === undefined ? "A write task must say what it serves." : `--serves ${request.serves} is not valid.`, fix: SERVES_FIX };
  }
  const done = /^done:(\d+)$/u.exec(request.serves);
  if (done === null) return undefined;
  const n = Number(done[1]);
  const checks = workstream.brief?.doneWhen.length ?? 0;
  if (n < checks) return undefined;
  return {
    message:
      checks === 0
        ? `${id} has no brief yet, so done:${n} names no done-when check.`
        : `done:${n} is not a done-when check of ${id}; it has ${checks} (done:0${checks > 1 ? ` to done:${checks - 1}` : ""}).`,
    fix: SERVES_FIX,
  };
};

/**
 * Review spawns (QA runs included): a PR to review, no clean verdict on its current head yet, and not a third round
 * after two clean verdicts in a row on different heads. `headSha` is undefined when GitHub could not be asked;
 * `verdicts` are this PR's, newest first. `maxRounds` is the playbook's maxReviewRounds: a lead's review of a head not
 * reviewed yet is refused once that many heads were. The train's own reviews are exempt, so it never stalls on it.
 */
export const reviewRefusal = (
  request: SpawnRequest,
  by: string,
  headSha: string | undefined,
  verdicts: ReadonlyArray<PrVerdict>,
  maxRounds?: number,
): Refusal | undefined => {
  if (request.kind !== "review") return undefined;
  if (request.pr === undefined) {
    return isHubCaller(by) ? undefined : { message: "A review task needs the PR it reviews.", fix: "Pass --pr <PR URL>." };
  }
  if (headSha !== undefined && verdicts.some((v) => v.sha === headSha && v.blocking === 0)) {
    return {
      message: `already reviewed at ${headSha} with 0 blocking findings`,
      fix: "Review stops after one clean pass per commit. Send it to the train, or push a fix and review the new head.",
    };
  }
  const [last, before] = verdicts;
  if (last !== undefined && before !== undefined && last.blocking === 0 && before.blocking === 0 && last.sha !== before.sha) {
    return {
      message: `${request.pr} had two clean reviews in a row (${before.sha.slice(0, 12)} by ${before.taskId}, ${last.sha.slice(0, 12)} by ${last.taskId}); a third review is a polish loop.`,
      fix: "Send the PR to the train. If you know of a blocking defect, fix it in a write task with --serves defect:<text>.",
      polishLoop: [
        `Review ${request.qa === true ? "(QA) " : ""}requested for ${request.pr} after two consecutive clean verdicts on different heads.`,
        `${before.taskId}: 0 blocking at ${before.sha}`,
        `${last.taskId}: 0 blocking at ${last.sha}`,
      ],
    };
  }
  const rounds = new Set(verdicts.map((v) => v.sha));
  if (maxRounds !== undefined && !isHubCaller(by) && rounds.size >= maxRounds && (headSha === undefined || !rounds.has(headSha))) {
    return {
      message: `${request.pr} has had ${rounds.size} review rounds, the most its playbook allows.`,
      fix: "Send the PR to the train. If it still has a blocking defect, fix it with a write task (--serves defect:<text>) and let the train's review gate check it, or ask the human.",
    };
  }
  return undefined;
};

/** One key per PR however its URL is written: host and path, lowercased, `/pulls/` as `/pull/`, no trailing slash. */
export const prKey = (url: string): string => {
  try {
    const u = new URL(url.trim());
    return `${u.host}${u.pathname}`.toLowerCase().replace(/\/pulls\//u, "/pull/").replace(/\/+$/u, "");
  } catch {
    return url.trim().toLowerCase();
  }
};
