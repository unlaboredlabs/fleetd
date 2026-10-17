import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  type Change,
  type Claim,
  type Decision,
  LeadCall,
  type LeadCallFrame,
  type LeadCallResult,
  LeadResultFrame,
  NODE_SOCKET_PATH,
  SERVES_FIX,
  type Task,
} from "@fleetd/contracts";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type { CliResult } from "./cli.ts";

// Lead-side commands. Their reader is an LLM running inside a lead or task, so every output says what to do next.

export const LEAD_USAGE = `  brief create --workstream <W> (--json '<Brief>' | --file <path>) [--amend <A>]
             freeze the brief of a draft workstream and start it
  ask --key <k> --class <product|money|credential|irreversible> --text <t> --rec <r>
      [--options a,b] [--blocks "<step>"] [--proceeded] [--workstream <W>]
  ask --kind do --key <k> --class <c> --text <t> --step '<json>' [--step '<json>' ...]
      [--verify '<check json>']
             a step is {"text","where":"<machine>|browser|phone","command"?,"expect"?}; --verify is a
             cmd or http check fleetd runs once the human ticks it done (a failure reopens it)
             ask the human; answers already in the decision log come back at once
  ask --kind secret --key <k> --sink env:<machine>:<path>|file:<machine>:<path> [--env-name <N>]
      --text <t> [--class credential]
             the human enters it on their phone, sealed to that machine; an env: sink writes the line
             <N>=<value> (N defaults to the key uppercased, . and - as _). You get its fingerprint, never the value
  gated run --class irreversible|money|credential --argv '<json array>' --reason <r> [--cwd <abs>]
      [--secret-env NAME=<secret key> ...] [--timeout <sec>] [--workstream <W>]
             a command the node runs exactly as stored, in the project workspace by default, only after
             a human approves it; secrets come from the node's own sinks. The result arrives in a wake
  ask withdraw <A> [--use <D>]
  decide --key <k> --value <v> [--why <w>] [--scope project|workstream] [--workstream <W>]
             log a decision you made yourself
  status set "<one line>" [--workstream <W>]
  decisions search "<query>"
  task spawn --workstream <W> --title <t> --prompt <p> [--kind write|read|review] [--areas a,b]
      [--model <m>] [--effort low|medium|high|max] [--tier S|M|L] [--estimate <min>]
      [--serves done:<n>|issue:<ref>|defect:<text>|ask:<A>] [--pr <url>] [--qa]
             delegate work to a subagent; writers need --areas and --serves and get their own
             branch; a review task needs --pr, and --qa marks it a QA run
  task list [--state <s>] [--workstream <W>]
  task status <T>
  task message <T> "<text>"
             steer a running task, answer a waiting one, or continue an ended one
  task cancel <T> [--reason <r>]
  claim done --workstream <W>
             fleetd runs the workstream's done-when checks itself; only all of them passing makes
             it done (exit 1 when a check did not pass)
  review verdict --task <T> --sha <full head SHA> --blocking <n> --non-blocking <n> --summary "<s>"
      [--baseline <n> --candidate <n>]
             the last step of a review task; a research judge also reports its metric for the
             baseline and the candidate, and fleetd computes GO, STOP or INCONCLUSIVE
  change enqueue --pr <url> [--task <T>] [--workstream <W>] [--serves <s>] [--tier S|M|L]
             put a PR on its repo's merge train (a write task's PR goes on by itself); its body
             needs a 'Source: <serves>' line. Only the train merges.
  change status <X>
  inventory  the project's open work ranked: failing checks, open issues (gh), open asks and
             TODO/FIXME markers; with nothing left that has a value source and no open child, the
             project's finish-all workstream goes idle
  workstream spawn --text "<intent>" --serves issue:<#n|url>|defect:<text>|done:<n>
      [--template bugfix|feature|research]
             a finish-all lead starts a child workstream for one item with a value source
             lead-side commands reach the hub through the local node (FLEETD_NODE_SOCK, default
             ~/${NODE_SOCKET_PATH}); exit 0 ok, 1 checks failed, 2 usage, 3 refused, 4 hub unreachable
`;

const LEAD_COMMANDS: ReadonlySet<string> = new Set(["brief", "ask", "decide", "status", "decisions", "task", "claim", "review", "change", "gated", "workstream", "inventory"]);

export const isLeadCommand = (argv: ReadonlyArray<string>) => argv[0] !== undefined && LEAD_COMMANDS.has(argv[0]);

const usage = (message: string): CliResult => ({ code: 2, stdout: "", stderr: `fleetd: ${message}\n\nusage:\n${LEAD_USAGE}` });

const decodeCall = Schema.decodeUnknownExit(LeadCall);

const parseJson = (flag: string, text: string): { readonly value: unknown } | { readonly error: string } => {
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { error: `${flag} is not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
};

const definedOnly = (record: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));

/** The call `argv` asks for, validated against the contract; a string is a usage error. */
export const parseLeadArgs = (
  argv: ReadonlyArray<string>,
  readFile: (file: string) => string = (file) => fs.readFileSync(file, "utf8"),
): LeadCall | string => {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        workstream: { type: "string" },
        json: { type: "string" },
        file: { type: "string" },
        amend: { type: "string" },
        kind: { type: "string" },
        key: { type: "string" },
        class: { type: "string" },
        text: { type: "string" },
        rec: { type: "string" },
        options: { type: "string" },
        step: { type: "string", multiple: true },
        blocks: { type: "string" },
        proceeded: { type: "boolean" },
        use: { type: "string" },
        value: { type: "string" },
        why: { type: "string" },
        scope: { type: "string" },
        title: { type: "string" },
        prompt: { type: "string" },
        areas: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        tier: { type: "string" },
        estimate: { type: "string" },
        serves: { type: "string" },
        pr: { type: "string" },
        qa: { type: "boolean" },
        state: { type: "string" },
        reason: { type: "string" },
        task: { type: "string" },
        sha: { type: "string" },
        blocking: { type: "string" },
        "non-blocking": { type: "string" },
        summary: { type: "string" },
        verify: { type: "string" },
        sink: { type: "string" },
        "env-name": { type: "string" },
        argv: { type: "string" },
        cwd: { type: "string" },
        "secret-env": { type: "string", multiple: true },
        timeout: { type: "string" },
        baseline: { type: "string" },
        candidate: { type: "string" },
        template: { type: "string" },
      },
    });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const { values: v, positionals } = parsed;
  const [command, sub, ...rest] = positionals;
  /** Flags that belong to a command; any other flag given is a usage error. */
  const only = (...allowed: ReadonlyArray<string>) => {
    const extra = Object.keys(v).find((flag) => !allowed.includes(flag));
    return extra === undefined ? undefined : `--${extra} does not apply to fleetd ${command}${sub === undefined ? "" : ` ${sub}`}`;
  };

  let raw: Record<string, unknown>;
  switch (command) {
    case "brief": {
      if (sub !== "create" || rest.length > 0) return "expected fleetd brief create --workstream <W> --json '<Brief>'";
      const wrong = only("workstream", "json", "file", "amend");
      if (wrong !== undefined) return wrong;
      if (v.workstream === undefined) return "--workstream is required";
      if ((v.json === undefined) === (v.file === undefined)) return "give the brief with exactly one of --json and --file";
      let text = v.json;
      if (text === undefined) {
        try {
          text = readFile(v.file!);
        } catch {
          return `cannot read --file ${v.file}`;
        }
      }
      const brief = parseJson(v.json === undefined ? "--file" : "--json", text);
      if ("error" in brief) return brief.error;
      raw = definedOnly({ op: "brief_create", workstreamId: v.workstream, brief: brief.value, amend: v.amend });
      break;
    }
    case "ask": {
      if (sub === "withdraw") {
        const wrong = only("use");
        if (wrong !== undefined) return wrong;
        if (rest.length !== 1) return "expected fleetd ask withdraw <A> [--use <D>]";
        raw = definedOnly({ op: "ask_withdraw", askId: rest[0], use: v.use });
        break;
      }
      if (sub !== undefined) return `unexpected '${sub}': put the question in --text`;
      const wrong = only("kind", "key", "class", "text", "rec", "options", "step", "verify", "sink", "env-name", "blocks", "proceeded", "workstream");
      if (wrong !== undefined) return wrong;
      // A secret is a credential unless the lead says otherwise.
      const cls = v.class ?? (v.kind === "secret" ? "credential" : undefined);
      for (const [flag, value] of [["key", v.key], ["class", cls], ["text", v.text]] as const) if (value === undefined) return `--${flag} is required`;
      if (v.kind === "secret" && v.sink === undefined) return "a secret ask needs --sink env:<machine>:<path> or file:<machine>:<path>";
      const verify = v.verify === undefined ? undefined : parseJson("--verify", v.verify);
      if (verify !== undefined && "error" in verify) return verify.error;
      const steps: Array<unknown> = [];
      for (const [i, step] of (v.step ?? []).entries()) {
        const value = parseJson(`--step ${i + 1}`, step);
        if ("error" in value) return value.error;
        steps.push(value.value);
      }
      raw = definedOnly({
        op: "ask",
        kind: v.kind,
        key: v.key,
        class: cls,
        text: v.text,
        recommendation: v.rec,
        options: v.options?.split(",").map((option) => option.trim()).filter((option) => option.length > 0),
        steps: steps.length > 0 ? steps : undefined,
        verify: verify?.value,
        sink: v.sink,
        envName: v["env-name"],
        blocks: v.blocks,
        proceededOnRec: v.proceeded,
        workstreamId: v.workstream,
      });
      break;
    }
    case "decide": {
      if (sub !== undefined) return `unexpected '${sub}': give the value with --value`;
      const wrong = only("key", "value", "why", "scope", "workstream");
      if (wrong !== undefined) return wrong;
      if (v.key === undefined) return "--key is required";
      if (v.value === undefined) return "--value is required";
      raw = definedOnly({ op: "decide", key: v.key, value: v.value, why: v.why, scope: v.scope, workstreamId: v.workstream });
      break;
    }
    case "status": {
      if (sub !== "set") return `expected fleetd status set "<one line>"`;
      const wrong = only("workstream");
      if (wrong !== undefined) return wrong;
      if (rest.length === 0) return `expected fleetd status set "<one line>"`;
      raw = definedOnly({ op: "status_set", text: rest.join(" "), workstreamId: v.workstream });
      break;
    }
    case "decisions": {
      if (sub !== "search") return `expected fleetd decisions search "<query>"`;
      const wrong = only();
      if (wrong !== undefined) return wrong;
      if (rest.length === 0) return `expected fleetd decisions search "<query>"`;
      raw = { op: "decisions_search", query: rest.join(" ") };
      break;
    }
    case "task": {
      switch (sub) {
        case "spawn": {
          if (rest.length > 0) return `unexpected '${rest[0]}': put the task's instructions in --prompt`;
          const wrong = only("workstream", "title", "prompt", "kind", "areas", "model", "effort", "tier", "estimate", "serves", "pr", "qa");
          if (wrong !== undefined) return wrong;
          for (const flag of ["workstream", "title", "prompt"] as const) if (v[flag] === undefined) return `--${flag} is required`;
          if (v.estimate !== undefined && !/^\d+(\.\d+)?$/u.test(v.estimate)) return `--estimate is minutes, got '${v.estimate}'`;
          // The contract refuses it too, but this says it in one plain line.
          if ((v.kind ?? "write") === "write" && v.serves === undefined) return `a write task needs --serves: ${SERVES_FIX}`;
          raw = definedOnly({
            op: "task_spawn",
            workstreamId: v.workstream,
            title: v.title,
            prompt: v.prompt,
            kind: v.kind,
            areas: v.areas?.split(",").map((area) => area.trim()).filter((area) => area.length > 0),
            model: v.model,
            effort: v.effort,
            tier: v.tier,
            estimateMinutes: v.estimate === undefined ? undefined : Number(v.estimate),
            serves: v.serves,
            pr: v.pr,
            qa: v.qa,
          });
          break;
        }
        case "list": {
          const wrong = only("state", "workstream");
          if (wrong !== undefined) return wrong;
          if (rest.length > 0) return `unexpected '${rest[0]}': filter with --state or --workstream`;
          raw = definedOnly({ op: "task_list", state: v.state, workstreamId: v.workstream });
          break;
        }
        case "status": {
          const wrong = only();
          if (wrong !== undefined) return wrong;
          if (rest.length !== 1) return "expected fleetd task status <T>";
          raw = { op: "task_status", taskId: rest[0] };
          break;
        }
        case "message": {
          const wrong = only();
          if (wrong !== undefined) return wrong;
          if (rest.length < 2) return `expected fleetd task message <T> "<text>"`;
          raw = { op: "task_message", taskId: rest[0], message: rest.slice(1).join(" ") };
          break;
        }
        case "cancel": {
          const wrong = only("reason");
          if (wrong !== undefined) return wrong;
          if (rest.length !== 1) return "expected fleetd task cancel <T> [--reason <r>]";
          raw = definedOnly({ op: "task_cancel", taskId: rest[0], reason: v.reason });
          break;
        }
        default:
          return `expected fleetd task spawn|list|status|message|cancel`;
      }
      break;
    }
    case "claim": {
      if (sub !== "done" || rest.length > 0) return "expected fleetd claim done --workstream <W>";
      const wrong = only("workstream");
      if (wrong !== undefined) return wrong;
      if (v.workstream === undefined) return "--workstream is required";
      raw = { op: "claim_done", workstreamId: v.workstream };
      break;
    }
    case "review": {
      if (sub !== "verdict" || rest.length > 0) return `expected fleetd review verdict --task <T> --sha <sha> --blocking <n> --non-blocking <n> --summary "<s>"`;
      const wrong = only("task", "sha", "blocking", "non-blocking", "summary", "baseline", "candidate");
      if (wrong !== undefined) return wrong;
      if ((v.baseline === undefined) !== (v.candidate === undefined)) return "give --baseline and --candidate together: the metric measured for each";
      for (const flag of ["baseline", "candidate"] as const) {
        if (v[flag] !== undefined && !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu.test(v[flag]!.trim())) return `--${flag} is a number, got '${v[flag]}'`;
      }
      for (const flag of ["task", "sha", "blocking", "non-blocking", "summary"] as const) if (v[flag] === undefined) return `--${flag} is required`;
      const sha = v.sha!.trim().toLowerCase();
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sha)) {
        return `--sha must be the full commit SHA (40 hex characters; \`git rev-parse HEAD\` or \`gh pr view <url> --json headRefOid\`), got '${v.sha}'`;
      }
      for (const flag of ["blocking", "non-blocking"] as const) if (!/^\d+$/u.test(v[flag]!)) return `--${flag} is a count of findings, got '${v[flag]}'`;
      raw = {
        op: "review_verdict",
        taskId: v.task,
        prHeadSha: sha,
        blocking: Number(v.blocking),
        nonBlocking: Number(v["non-blocking"]),
        summary: v.summary,
        ...(v.baseline === undefined ? {} : { metricValues: { baseline: Number(v.baseline), candidate: Number(v.candidate) } }),
      };
      break;
    }
    case "change": {
      if (sub === "enqueue") {
        const wrong = only("pr", "task", "workstream", "serves", "tier");
        if (wrong !== undefined) return wrong;
        if (rest.length > 1 || (rest.length === 1 && v.pr !== undefined)) return "expected fleetd change enqueue --pr <url>";
        const prUrl = v.pr ?? rest[0];
        if (prUrl === undefined) return "--pr is required";
        raw = definedOnly({ op: "change_enqueue", prUrl, taskId: v.task, workstreamId: v.workstream, serves: v.serves, tier: v.tier });
        break;
      }
      if (sub === "status") {
        const wrong = only();
        if (wrong !== undefined) return wrong;
        if (rest.length !== 1) return "expected fleetd change status <X>";
        raw = { op: "change_status", changeId: rest[0] };
        break;
      }
      return "expected fleetd change enqueue|status";
    }
    case "gated": {
      if (sub !== "run" || rest.length > 0) return "expected fleetd gated run --class <c> --argv '<json array>' --reason <r>";
      const wrong = only("class", "argv", "reason", "cwd", "secret-env", "timeout", "workstream");
      if (wrong !== undefined) return wrong;
      for (const flag of ["class", "argv", "reason"] as const) if (v[flag] === undefined) return `--${flag} is required`;
      const argvJson = parseJson("--argv", v.argv!);
      if ("error" in argvJson) return argvJson.error;
      if (!Array.isArray(argvJson.value) || !argvJson.value.every((word) => typeof word === "string")) {
        return `--argv is a JSON array of strings, e.g. '["sh","-c","echo hi"]'`;
      }
      const secretEnv: Array<{ name: string; secretKey: string }> = [];
      for (const entry of v["secret-env"] ?? []) {
        const at = entry.indexOf("=");
        if (at <= 0 || at === entry.length - 1) return `--secret-env is NAME=<secret key>, got '${entry}'`;
        secretEnv.push({ name: entry.slice(0, at), secretKey: entry.slice(at + 1) });
      }
      if (v.timeout !== undefined && !/^\d+$/u.test(v.timeout)) return `--timeout is whole seconds, got '${v.timeout}'`;
      raw = definedOnly({
        op: "gated_run",
        argv: argvJson.value,
        cwd: v.cwd,
        class: v.class,
        reason: v.reason,
        secretEnv: secretEnv.length > 0 ? secretEnv : undefined,
        timeoutSec: v.timeout === undefined ? undefined : Number(v.timeout),
        workstreamId: v.workstream,
      });
      break;
    }
    case "workstream": {
      if (sub !== "spawn" || rest.length > 0) return `expected fleetd workstream spawn --text "<intent>" --serves <value source>`;
      const wrong = only("text", "serves", "template");
      if (wrong !== undefined) return wrong;
      for (const flag of ["text", "serves"] as const) if (v[flag] === undefined) return `--${flag} is required`;
      raw = definedOnly({ op: "workstream_spawn", text: v.text, serves: v.serves, template: v.template });
      break;
    }
    case "inventory": {
      if (sub !== undefined) return "expected fleetd inventory";
      const wrong = only();
      if (wrong !== undefined) return wrong;
      raw = { op: "inventory" };
      break;
    }
    default:
      return `unknown command '${command ?? ""}'`;
  }
  const call = decodeCall(raw, { errors: "all" });
  if (Exit.isSuccess(call)) return call.value;
  const error = Cause.squash(call.cause);
  return `invalid input: ${error instanceof Error ? error.message.replace(/\s*\n\s*/gu, " ") : "does not match the contract"}`;
};

/**
 * The working directory as the caller's shell names it. T3 keeps workspace roots as written, symlinks included, and
 * starts agents there, so the shell's logical `PWD` matches a root where the kernel's resolved path may not.
 */
export const callerCwd = (env: NodeJS.ProcessEnv, physical: string) => {
  const logical = env.PWD;
  if (logical === undefined || !path.isAbsolute(logical)) return physical;
  try {
    return fs.realpathSync(logical) === fs.realpathSync(physical) ? path.normalize(logical) : physical;
  } catch {
    return physical;
  }
};

export const nodeSocketPath = (env: NodeJS.ProcessEnv) =>
  env.FLEETD_NODE_SOCK !== undefined && env.FLEETD_NODE_SOCK.length > 0
    ? env.FLEETD_NODE_SOCK
    : path.join(os.homedir(), NODE_SOCKET_PATH);

/** A reason the node could not be asked or did not answer. */
export interface Unreachable {
  readonly unreachable: string;
}

const decodeResult = Schema.decodeUnknownExit(Schema.fromJsonString(LeadResultFrame));

/** One frame out, one frame back over the node's socket. The node answers within ~35 s; `timeoutMs` is a backstop. */
export const sendToNode = (socketPath: string, frame: LeadCallFrame, timeoutMs = 60_000) =>
  new Promise<LeadResultFrame | Unreachable>((resolve) => {
    const conn = net.connect(socketPath);
    let received = "";
    let settled = false;
    const settle = (outcome: LeadResultFrame | Unreachable) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(
      () =>
        settle({
          unreachable: `the fleetd node did not answer within ${timeoutMs / 1000} s; the call may or may not have gone through — try again shortly`,
        }),
      timeoutMs,
    );
    conn.setEncoding("utf8");
    conn.on("connect", () => conn.write(`${JSON.stringify(frame)}\n`));
    conn.on("data", (chunk: string) => {
      received += chunk;
      const newline = received.indexOf("\n");
      if (newline < 0) return;
      const result = decodeResult(received.slice(0, newline));
      settle(Exit.isSuccess(result) ? result.value : { unreachable: "the fleetd node sent an answer this CLI cannot read; check that node and CLI versions match" });
    });
    conn.on("end", () => settle({ unreachable: "the fleetd node closed the connection without answering — try again shortly" }));
    conn.on("error", (error: NodeJS.ErrnoException) =>
      settle({
        unreachable:
          error.code === "ENOENT" || error.code === "ECONNREFUSED"
            ? `fleetd hub unreachable: no fleetd node is listening at ${socketPath} (set FLEETD_NODE_SOCK if it is elsewhere) — tell the human the node is down and carry on`
            : `cannot reach the fleetd node at ${socketPath}: ${error.message}`,
      }),
    );
  });

const scopeLabel = (decision: Decision) =>
  decision.scope.kind === "workstream" ? `workstream ${decision.scope.workstreamId}` : decision.scope.kind;

const decisionLine = (decision: Decision) =>
  `${decision.decisionId} ${decision.key} = ${decision.value} (${scopeLabel(decision)}, by ${decision.source})`;

const taskLine = (task: Task) => {
  const where = task.kind === "write" ? `, ${task.areas.join(",")}` : "";
  const why = task.state === "queued" && task.queuedReason !== undefined ? ` (${task.queuedReason})` : "";
  return `${task.taskId} ${task.state}${why} [${task.kind}${where}, ${task.model}/${task.effort}] ${task.title}${task.branch === undefined ? "" : ` on ${task.branch}`}`;
};

const quoted = (text: string) => text.trim().split("\n").map((line) => `  > ${line}`.trimEnd());

/** One line per check fleetd ran, ✓ only for a pass, with the evidence of any that did not pass. */
const claimLines = (claim: Claim) =>
  claim.results.flatMap((r) => {
    const head = `${r.result === "pass" ? "✓" : "✗"} done:${r.checkIndex} ${r.spec.type}: ${r.result}${r.exitCode === undefined ? "" : `, exit ${r.exitCode}`}`;
    return r.result === "pass" || r.evidence.trim() === "" ? [head] : [head, ...quoted(r.evidence).map((line) => `  ${line}`)];
  });

/** The next step for a task in this state. */
const taskNext = (task: Task) => {
  switch (task.state) {
    case "queued":
      return `nothing to do; ${task.taskId} starts by itself once that clears, and its result arrives inline in a later wake. End your turn when you have nothing else to do.`;
    case "running":
      return `don't poll it. ${task.taskId}'s result arrives inline in a later wake; end your turn when you have nothing else to do.`;
    case "idle":
      return `${task.taskId} is waiting for input: answer it with fleetd task message ${task.taskId} "<answer>", or fleetd task cancel ${task.taskId}.`;
    case "done":
    case "failed":
      return `judge the result. fleetd task message ${task.taskId} "<text>" continues the same thread; or spawn a follow-up task.`;
    case "cancelled":
      return "nothing; spawn a new task if the work is still needed.";
  }
};

/** Every field the lead may need about one task, then its result if it has one. */
const taskDetail = (task: Task) => {
  const lines = [
    taskLine(task),
    `  workstream ${task.workstreamId}${task.serves === undefined ? "" : `, serves ${task.serves}`}${task.pr === undefined ? "" : `, reviews ${task.pr}${task.qa === true ? " (QA)" : ""}`}, attempt ${task.attempt}`,
  ];
  if (task.threadRef !== undefined) lines.push(`  thread ${task.threadRef.machineId}/${task.threadRef.threadId}`);
  if (task.result !== undefined) {
    const { result } = task;
    lines.push(`  result (${result.status}${result.prUrl === undefined ? "" : `, PR ${result.prUrl}`}):`, ...(result.tail.trim() === "" ? ["  > (no final message)"] : quoted(result.tail)));
  }
  return lines;
};

/** A Change: where it is on the train, its reviews, and why it is parked if it is. */
const changeLines = (change: Change) => {
  const where = change.position === undefined ? "" : `, ${change.position === 0 ? "next in line" : `${change.position} ahead of it`}`;
  const lines = [
    `${change.changeId} ${change.repo}#${change.prNumber} ${change.state}${where} (tier ${change.tier}, serves ${change.serves}${change.taskId === undefined ? "" : `, by ${change.taskId}`})`,
    `  ${change.prUrl} at ${change.headSha.slice(0, 12)}${change.mergedSha === undefined ? "" : `, merged as ${change.mergedSha.slice(0, 12)}`}`,
  ];
  if (change.reviews.length > 0) {
    lines.push(`  reviews: ${change.reviews.map((r) => `${r.taskId} ${r.blocking} blocking at ${r.prHeadSha.slice(0, 12)}`).join(", ")}`);
  }
  if (change.lastError !== undefined) lines.push(...quoted(change.lastError));
  return lines;
};

/** What happened, then `Next:` with the hub's hint or a default. */
export const formatResult = (result: LeadCallResult): string => {
  const lines: Array<string> = [];
  let next: string;
  switch (result.op) {
    case "brief_create":
      lines.push(`Brief for ${result.workstreamId} frozen (hash ${result.briefHash.slice(0, 12)}); the workstream is ${result.state}.`);
      next = "carry on with the workstream. Changing this brief later needs a human-answered ask and --amend.";
      break;
    case "ask":
      if (result.state === "auto" && result.decision !== undefined) {
        lines.push(`Already decided, so not asked: ${decisionLine(result.decision)}.`);
        next = "use this answer and do not ask again.";
        break;
      }
      if (result.state !== "open") {
        lines.push(`${result.askId} is ${result.state}.`);
        if (result.decision !== undefined) lines.push(`Answer: ${decisionLine(result.decision)}.`);
        next = "carry on.";
        break;
      }
      lines.push(
        result.attached === true
          ? `An ask with this key is already open as ${result.askId}; yours was attached to it.`
          : `Filed ${result.askId}. It goes to the human in the next batch.`,
      );
      if (result.candidates !== undefined && result.candidates.length > 0) {
        lines.push("Decisions that may already answer it:", ...result.candidates.map((decision) => `  ${decisionLine(decision)}`));
        next = `if one of these answers it, run fleetd ask withdraw ${result.askId} --use <D>; otherwise carry on without waiting. The answer arrives in a later wake.`;
      } else {
        next = "carry on without waiting; the answer arrives in a later wake.";
      }
      break;
    case "ask_withdraw":
      lines.push(`${result.askId} is ${result.state}.`);
      next = "carry on.";
      break;
    case "decide":
      lines.push(`Logged ${decisionLine(result.decision)}.`);
      next = "carry on. This key will not be asked again in this scope.";
      break;
    case "status_set":
      lines.push(`Status set for ${result.workstreamId}.`);
      next = "carry on.";
      break;
    case "decisions_search":
      if (result.decisions.length === 0) {
        lines.push("No decisions match.");
        next = "decide it yourself and log it with fleetd decide; use fleetd ask only for product, money, credential or irreversible calls.";
      } else {
        lines.push(...result.decisions.map(decisionLine));
        next = "use these answers; do not ask about these keys again.";
      }
      break;
    case "task_spawn": {
      const { task } = result;
      if (task.state === "failed") {
        lines.push(`${task.taskId} could not start.`, ...taskDetail(task));
        next = "fix what the result says, then spawn it again.";
        break;
      }
      lines.push(`Spawned ${task.taskId}: ${task.state === "queued" ? `queued (${task.queuedReason ?? "waiting"})` : task.state}.`, taskLine(task));
      next = taskNext(task);
      break;
    }
    case "task_status":
      lines.push(...taskDetail(result.task));
      next = taskNext(result.task);
      break;
    case "task_message":
      lines.push(
        result.task.state === "queued"
          ? `Message for ${result.task.taskId} held until it starts (${result.task.queuedReason ?? "queued"}).`
          : `Message sent to ${result.task.taskId}.`,
        taskLine(result.task),
      );
      next = result.task.state === "queued" ? taskNext(result.task) : `don't poll it. ${result.task.taskId}'s result arrives inline in a later wake.`;
      break;
    case "task_cancel":
      lines.push(`${result.task.taskId} cancelled; its slot and areas are free.`);
      next = taskNext(result.task);
      break;
    case "task_list":
      lines.push(...(result.tasks.length === 0 ? ["No tasks."] : result.tasks.map(taskLine)));
      if (result.truncated === true) lines.push("(older tasks not shown; filter with --state or --workstream)");
      next = result.tasks.length === 0 ? "spawn work with fleetd task spawn." : "fleetd task status <T> shows one task's result.";
      break;
    case "claim_done": {
      const { claim } = result;
      if (claim === undefined) {
        lines.push(`${result.claimId} on ${result.workstreamId} is still running its checks; ${result.workstreamId} is ${result.state}.`);
        next = "carry on with other work; the outcome arrives in a wake.";
      } else if (claim.outcome === "pass") {
        lines.push(`${result.claimId} on ${result.workstreamId} passed: fleetd ran all ${claim.results.length} done-when checks and each passed. ${result.workstreamId} is ${result.state}.`, ...claimLines(claim));
        next = `spawn nothing more for ${result.workstreamId}.`;
      } else {
        const failing = claim.results.filter((r) => r.result !== "pass").length;
        lines.push(`${result.claimId} on ${result.workstreamId} failed: ${failing} of ${claim.results.length} checks did not pass. ${result.workstreamId} is ${result.state}, not done.`, ...claimLines(claim));
        next = "fix what failed, then claim again.";
      }
      break;
    }
    case "review_verdict": {
      const v = result.verdict;
      const metric = v.metricValues === undefined ? "" : ` Metric: baseline ${v.metricValues.baseline}, candidate ${v.metricValues.candidate}.`;
      lines.push(`Recorded the verdict of ${v.taskId} at ${v.prHeadSha.slice(0, 12)}: ${v.blocking} blocking, ${v.nonBlocking} non-blocking.${metric}`);
      next = "end with your one-paragraph result and stop.";
      break;
    }
    case "workstream_spawn":
      lines.push(`Spawned ${result.workstreamId}, a child of ${result.parent}${result.playbook === undefined ? "" : ` on ${result.playbook.split("@")[0]}`}.`);
      next = `register its brief with fleetd brief create --workstream ${result.workstreamId} when its intent wake arrives.`;
      break;
    case "inventory":
      lines.push(result.text);
      next = result.idle
        ? "stop: nothing is left with a value source."
        : result.spawnable === 0
          ? "nothing new to spawn; wait for the open children."
          : 'fleetd workstream spawn --text "<intent>" --serves <the item\'s value source>, highest first.';
      break;
    case "change_enqueue":
    case "change_status":
      lines.push(...changeLines(result.change));
      next = "don't merge it yourself; the train merges and the outcome arrives in a wake.";
      break;
    case "gated_run":
      lines.push(`${result.askId} ${result.state}: the command is stored and waits for a human to approve it; nothing runs before that.`);
      next = "carry on with other work; the exit code and output tail arrive in a wake.";
      break;
  }
  return `${lines.join("\n")}\nNext: ${result.next ?? next}\n`;
};

export interface LeadDeps {
  readonly env: NodeJS.ProcessEnv;
  /** The process's resolved working directory. */
  readonly cwd: string;
  readonly send?: (socketPath: string, frame: LeadCallFrame) => Promise<LeadResultFrame | Unreachable>;
  readonly readFile?: (file: string) => string;
}

/** `fleetd brief|ask|decide|status|decisions|task|claim|review|change|gated|workstream|inventory …`: one call to the hub through the local node. */
export const leadCommand = async (argv: ReadonlyArray<string>, deps: LeadDeps): Promise<CliResult> => {
  const call = parseLeadArgs(argv, deps.readFile);
  if (typeof call === "string") return usage(call);
  const frame: LeadCallFrame = { t: "lead_call", id: `cli-${process.pid}`, cwd: callerCwd(deps.env, deps.cwd), call };
  const answer = await (deps.send ?? sendToNode)(nodeSocketPath(deps.env), frame);
  if ("unreachable" in answer) return { code: 4, stdout: "", stderr: `fleetd: ${answer.unreachable}\n` };
  if (answer.result !== undefined) {
    // A claim that ran and failed is an answer, not a refusal, but it must not read as success to a script.
    const failed = answer.result.op === "claim_done" && answer.result.claim?.outcome === "fail";
    return { code: failed ? 1 : 0, stdout: formatResult(answer.result), stderr: "" };
  }
  const { code, message, fix } = answer.error!;
  const text = `${message}${fix === undefined ? "" : `\nNext: ${fix}`}\n`;
  return code === "machine_offline"
    ? { code: 4, stdout: "", stderr: `fleetd: ${text}` }
    : { code: 3, stdout: "", stderr: `Refused: ${text}` };
};
