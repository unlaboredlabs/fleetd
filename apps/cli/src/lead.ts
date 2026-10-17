import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  type Decision,
  LeadCall,
  type LeadCallFrame,
  type LeadCallResult,
  LeadResultFrame,
  NODE_SOCKET_PATH,
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
             a step is {"text","where":"<machine>|browser|phone","command"?,"expect"?}
             ask the human; answers already in the decision log come back at once
  ask withdraw <A> [--use <D>]
  decide --key <k> --value <v> [--why <w>] [--scope project|workstream] [--workstream <W>]
             log a decision you made yourself
  status set "<one line>" [--workstream <W>]
  decisions search "<query>"
  task spawn --workstream <W> --title <t> --prompt <p> [--kind write|read|review] [--areas a,b]
      [--model <m>] [--effort low|medium|high|max] [--tier S|M|L] [--estimate <min>] [--serves <s>]
             delegate work to a subagent; writers need --areas and get their own branch
  task list [--state <s>] [--workstream <W>]
  task status <T>
  task message <T> "<text>"
             steer a running task, answer a waiting one, or continue an ended one
  task cancel <T> [--reason <r>]
             lead-side commands reach the hub through the local node (FLEETD_NODE_SOCK, default
             ~/${NODE_SOCKET_PATH}); exit 0 ok, 2 usage, 3 refused, 4 hub unreachable
`;

const LEAD_COMMANDS: ReadonlySet<string> = new Set(["brief", "ask", "decide", "status", "decisions", "task"]);

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
        state: { type: "string" },
        reason: { type: "string" },
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
      const wrong = only("kind", "key", "class", "text", "rec", "options", "step", "blocks", "proceeded", "workstream");
      if (wrong !== undefined) return wrong;
      for (const flag of ["key", "class", "text"] as const) if (v[flag] === undefined) return `--${flag} is required`;
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
        class: v.class,
        text: v.text,
        recommendation: v.rec,
        options: v.options?.split(",").map((option) => option.trim()).filter((option) => option.length > 0),
        steps: steps.length > 0 ? steps : undefined,
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
          const wrong = only("workstream", "title", "prompt", "kind", "areas", "model", "effort", "tier", "estimate", "serves");
          if (wrong !== undefined) return wrong;
          for (const flag of ["workstream", "title", "prompt"] as const) if (v[flag] === undefined) return `--${flag} is required`;
          if (v.estimate !== undefined && !/^\d+(\.\d+)?$/u.test(v.estimate)) return `--estimate is minutes, got '${v.estimate}'`;
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
  const lines = [taskLine(task), `  workstream ${task.workstreamId}${task.serves === undefined ? "" : `, serves ${task.serves}`}, attempt ${task.attempt}`];
  if (task.threadRef !== undefined) lines.push(`  thread ${task.threadRef.machineId}/${task.threadRef.threadId}`);
  if (task.result !== undefined) {
    const { result } = task;
    lines.push(`  result (${result.status}${result.prUrl === undefined ? "" : `, PR ${result.prUrl}`}):`, ...(result.tail.trim() === "" ? ["  > (no final message)"] : quoted(result.tail)));
  }
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
    // Placeholder lines until `claim done` and `review verdict` land (M6c).
    case "claim_done":
      lines.push(`${result.claimId} ${result.workstreamId} ${result.claim?.outcome ?? "checking"}; workstream ${result.state}`);
      next = "carry on; failing checks arrive in a wake with their evidence.";
      break;
    case "review_verdict":
      lines.push(`Verdict for ${result.verdict.taskId} at ${result.verdict.prHeadSha.slice(0, 12)}: ${result.verdict.blocking} blocking`);
      next = "stop here; this review is finished.";
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

/** `fleetd brief|ask|decide|status|decisions|task …`: one call to the hub through the local node. */
export const leadCommand = async (argv: ReadonlyArray<string>, deps: LeadDeps): Promise<CliResult> => {
  const call = parseLeadArgs(argv, deps.readFile);
  if (typeof call === "string") return usage(call);
  const frame: LeadCallFrame = { t: "lead_call", id: `cli-${process.pid}`, cwd: callerCwd(deps.env, deps.cwd), call };
  const answer = await (deps.send ?? sendToNode)(nodeSocketPath(deps.env), frame);
  if ("unreachable" in answer) return { code: 4, stdout: "", stderr: `fleetd: ${answer.unreachable}\n` };
  if (answer.result !== undefined) return { code: 0, stdout: formatResult(answer.result), stderr: "" };
  const { code, message, fix } = answer.error!;
  const text = `${message}${fix === undefined ? "" : `\nNext: ${fix}`}\n`;
  return code === "machine_offline"
    ? { code: 4, stdout: "", stderr: `fleetd: ${text}` }
    : { code: 3, stdout: "", stderr: `Refused: ${text}` };
};
