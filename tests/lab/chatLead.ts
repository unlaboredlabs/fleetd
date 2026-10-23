// The per-project lead chat, end to end (`npm run lab -- chat`, only when named, so it gets a hub of its own). A person
// talks to a project's lead in plain chat messages (chat_send with a human key) and the lead does the work: no
// questions tool, no cards. The lead runs on the shipped model (SHIPPED; a new project's lead starts on the hub
// default, which is that model), since how it talks is what these parts check; agents the harness spawns are
// on MECHANICS. Parts, in run order (FLEETD_LAB_CHAT_PARTS=a,b picks some):
// On the lab repo (this slot's namespace of unlaboredlabs/fleetd-lab, reset before and after), one lead:
// - work:    a plain chat message becomes a PR the train merges.
// - terse:   the lead asks in chat as numbered items with a recommendation each (needs-you on); "1 go" is logged as a
//            decision and acted on.
// - secret:  a secret request is an inline chat item filled with a human key; the value is in no chat message, event,
//            lead transcript or hub file.
// - gated:   a gated command is an inline chat item; nothing runs, and its state stays open, until a human Approve.
// - build:   bug (a): a research result that offers a build, then "build it", starts a writer; the research order does
//            not just close.
// - fixes:   bug (b), W1/T4: claim_done is refused while a fix hasn't landed, and a claim that passes while a fix is
//            open keeps the workstream open; only a deliberate close-over (which names what it drops) cancels a fix.
// - cap1:    at max agents 1, the review that gates a merge gets the slot before a queued agent; the train merges.
// - tools:   no session (lead, writer, reviewer, reader) has an ask tool, and the hub has no inbox tools.
// - plain:   the lead's chat messages carry no internal ids.
// Off the lab repo, no CI (areas on a local repo on lab-b with packages/a and packages/b and no `areas`; cap on its own):
// - history: an order placed through a pre-chat build shows up as history in the project's chat once the
//            build under test opens that hub's home (FLEETD_LAB_PRECHAT_BIN; its own small hub, no node).
// - areas:   bug (c): areas are inferred from the workspace, and two writers in them run at the same time.
// - cap:     max agents 2 with six agents never runs more than 2 and all finish; 12 → 3 mid-run kills nothing and new
//            spawns wait; 3 → 12 starts the queue at once, says so in one chat line, and tells the lead.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import sodium from "libsodium-wrappers";
import { DatabaseSync } from "node:sqlite";
import { type Body, callToolWith, cli, fleetdCommand, machineHome, openWorkstream, RUN, LAB, type Lab, MECHANICS, nodeHome, SHIPPED, nodeSock, requireGhLogin, scrubbedEnv, sessionText, slotPort, userMessages } from "./harness.ts";
import { BASE, checkClone, CLONE, NAMESPACE, onBase, prepareCheckout, REPO, removeLabRepoProject, resetNamespace } from "./m7Train.ts";

const LEAD_MACHINE = "lab-a";
const WORK_MACHINE = "lab-b";
const TURN_MS = 240_000;
const CI_MS = 600_000;
const ENDED = ["thread.completed", "thread.failed", "thread.interrupted"];
const TASK_ENDS = ["task.completed", "task.failed", "task.cancelled"];
const STAMP = new Date().toISOString().slice(0, 19).replace(/\D/gu, "");
const DIR = `lab/chat-${STAMP}`;
const DEFAULTS = `defaults:\n  model: ${MECHANICS.model}\n  effort: ${MECHANICS.effort}\n`;
// The lab repo names its one area, so its parts don't hang on inference; the local repo has no `areas` (bug (c)).
const LAB_REPO_POLICY = `areas:\n  all: ["**"]\n${DEFAULTS}`;
const LOCAL_REPO = path.join(LAB, "repo-chat");
/** The cap part's repo: its own project, with its one area named, so the cap is all it tests. */
const CAP_REPO = path.join(LAB, "repo-cap");
/** The history part's own hub; 4782 differs mod 20 from the other lab ports (harness.ts SLOT). */
const HISTORY_PORT = slotPort(4782);
/** For a lead the harness keeps out of the way. */
const QUIET = "Lab run: the harness does everything for this order. Reply to each wake about it with one short line; run no commands and start no agents for it.";
const PARTS = ["work", "terse", "secret", "gated", "build", "fixes", "cap1", "tools", "plain", "history", "areas", "cap"] as const;
type Part = (typeof PARTS)[number];
const LAB_REPO_PARTS: ReadonlyArray<Part> = ["work", "terse", "secret", "gated", "build", "fixes", "cap1", "tools", "plain"];

/** The hub tools the chat model brings, with the slice that brings each. */
const TOOL_FROM: Readonly<Record<string, string>> = {
  chat_send: "H1, EFF-A",
  chat_history: "H1, EFF-A",
  approval_answer: "H2, NS",
  secret_submit: "H2, NS",
  cap_set: "CAP",
};
/** Tools gone from the hub; none may be listed. */
const GONE_HUB_TOOLS = ["asks_list", "inbox_reply", "inbox_undo", "digest_get"];
/** An ask tool in a session's init list: fleetd's own (lead) or Claude's. The worker's ask_lead (to its lead) stays. */
const ASK_TOOL = /^(mcp__fleetd__ask|mcp__fleetd__ask_withdraw|AskUserQuestion)$/u;
/** Internal ids a lead message must not carry: workstream, task, plan, milestone, claim, request, decision and other hub ids. */
const INTERNAL_ID = /\b[WTPMCRHXQD]\d+\b/u;
/** A recommendation in a numbered question, in the lead's words. */
const RECOMMENDS = /\b(rec(ommend\w*)?|suggest\w*|i'd (go with|pick|choose|lean)|my pick)\b/iu;
/** How soon needs-you must clear after the person's reply. */
const NEEDS_YOU_CLEARS_MS = 3_000;
/** main's lead prompt before the chat rewrite (H3); the lead must start on a newer one. */
const OLD_LEAD_PROMPT = "lead.start@82105e96e9";

type Ref = { readonly machineId: string; readonly projectId: string };

const wanted = (): ReadonlySet<Part> => {
  const raw = process.env.FLEETD_LAB_CHAT_PARTS;
  if (raw === undefined || raw.trim() === "") return new Set(PARTS);
  const names = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = names.filter((n) => !(PARTS as ReadonlyArray<string>).includes(n));
  if (unknown.length > 0) throw new Error(`FLEETD_LAB_CHAT_PARTS: unknown ${unknown.join(", ")}; known: ${PARTS.join(", ")}`);
  return new Set(names as Array<Part>);
};

const mcpWith = async (hubUrl: string, key: string) => {
  const client = new Client({ name: "fleetd-chat-lab", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${hubUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }) as Transport);
  return { client, callTool: callToolWith(() => client) };
};

/** `fleetd …` from a project's workspace through a machine's node socket, as a lead's shell runs it. */
const shellIn = (machineId: string, root: string) => (...args: Array<string>) => {
  const out = spawnSync(...fleetdCommand(args), { cwd: root, encoding: "utf8", env: { ...scrubbedEnv(), PWD: root, FLEETD_NODE_SOCK: nodeSock(machineId) } });
  return { code: out.status, stdout: out.stdout, stderr: out.stderr };
};
type Shell = ReturnType<typeof shellIn>;

/** The same, without blocking: for a call that waits on the hub (a claim's checks) while the harness acts. */
const shellAsync = (machineId: string, root: string, ...args: Array<string>) =>
  new Promise<{ code: number | null; text: string }>((resolve) => {
    const [bin, argv] = fleetdCommand(args);
    const child = spawn(bin, argv, { cwd: root, env: { ...scrubbedEnv(), PWD: root, FLEETD_NODE_SOCK: nodeSock(machineId) } });
    let text = "";
    child.stdout.on("data", (d) => (text += String(d)));
    child.stderr.on("data", (d) => (text += String(d)));
    child.on("close", (code) => resolve({ code, text }));
  });

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...scrubbedEnv(), GIT_AUTHOR_NAME: "lab", GIT_AUTHOR_EMAIL: "lab@localhost", GIT_COMMITTER_NAME: "lab", GIT_COMMITTER_EMAIL: "lab@localhost" },
  });

/** A fresh local repo with two workspace packages and `policy`. */
const seedLocalRepo = (dir: string, policy: string) => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const p of ["a", "b"]) {
    fs.mkdirSync(path.join(dir, "packages", p), { recursive: true });
    fs.writeFileSync(path.join(dir, "packages", p, "README.md"), `# package ${p}\n`);
  }
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: path.basename(dir), private: true, workspaces: ["packages/*"] }, null, 2)}\n`);
  fs.mkdirSync(path.join(dir, ".fleetd"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".fleetd/policy.yaml"), policy);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "chat lab: two workspace packages");
};

/** Every event since `cursor` (optionally of `types`), paged to the end. */
const eventsSince = async (lab: Lab, cursor: number, types?: ReadonlyArray<string>) => {
  const out: Array<Body> = [];
  for (;;) {
    const page = (await lab.callTool("events_wait", { cursor, timeoutSec: 0, ...(types === undefined ? {} : { types }) })).body;
    out.push(...(page.events as Array<Body>));
    if (!page.more) return out;
    cursor = page.cursor;
  }
};

const initToolsOf = (machineId: string, threadId: string): Array<string> => {
  const file = path.join(nodeHome(machineId), "transcripts", `${threadId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  // Newer nodes wrap each line as {dir, ms, msg}; older ones write the message itself.
  const init = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Body)
    .map((l) => (l.msg ?? l) as Body)
    .find((m) => m.type === "system" && m.subtype === "init");
  return (init?.tools as Array<string> | undefined) ?? [];
};

const filesUnder = (dir: string): Array<[string, string]> =>
  !fs.existsSync(dir)
    ? []
    : fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry): Array<[string, string]> => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return filesUnder(full);
        return entry.isFile() ? [[full, fs.readFileSync(full).toString("latin1")]] : [];
      });

const tasksOf = async (lab: Lab, ref: Ref) => ((await lab.callTool("tasks_list", { projectRef: ref, limit: 100 })).body.tasks as Array<Body>) ?? [];
const taskGet = async (lab: Lab, taskId: string) => (await lab.callTool("task_get", { taskId })).body.task as Body;
const sameProject = (projectRef: Body | undefined, ref: Ref) => projectRef?.machineId === ref.machineId && projectRef?.projectId === ref.projectId;

/** The next agent of the project that starts after `cursor` and satisfies `pred`; others are passed over. */
const nextTask = async (lab: Lab, ref: Ref, cursor: number, what: string, ms: number, pred: (t: Body) => boolean = () => true) => {
  const deadline = Date.now() + ms;
  for (let from = cursor; ; ) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`timed out after ${ms / 1000}s: ${what}`);
    const started = await lab.waitEvent(what, left, { cursor: from, types: ["task.started"] });
    from = started.cursor;
    const task = await taskGet(lab, started.event.data.taskId as string);
    if (sameProject(task.projectRef, ref) && pred(task)) return { task, seq: started.event.seq as number, cursor: started.cursor };
  }
};

/** A workstream for an order the harness drives, its brief frozen from the shell as a lead would. */
const quietOrder = async (lab: Lab, ref: Ref, fleetd: Shell, title: string, doneWhen: ReadonlyArray<Body>, tier: "S" | "M" = "S") => {
  const w = openWorkstream(lab.check, fleetd, title);
  const brief = { goal: title, why: "the chat lab scenario", pointers: [], constraints: [], tier, doneWhen };
  const frozen = fleetd("brief", "create", "--workstream", w, "--json", JSON.stringify(brief));
  lab.check(frozen.code === 0, `brief create ${w}: ${JSON.stringify(frozen)}`);
  return w;
};

const spawned = (lab: Lab, out: { code: number | null; stdout: string; stderr: string }, what: string) => {
  const taskId = /^Spawned (T\d+)/mu.exec(out.stdout)?.[1];
  lab.check(out.code === 0 && taskId, `${what}: ${JSON.stringify(out)}`);
  return taskId!;
};

/** Read agents that hold a slot for `sec` seconds, spawned from the shell (one tiny turn each). */
const spawnSleepers = (lab: Lab, fleetd: Shell, workstreamId: string, label: string, n: number, sec: number) =>
  Array.from({ length: n }, (_, i) => {
    const out = fleetd(
      "task", "spawn", "--workstream", workstreamId, "--title", `${label} ${i + 1}`, "--kind", "read", "--model", MECHANICS.model, "--effort", MECHANICS.effort,
      "--prompt", `Run the shell command \`sleep ${sec}\` once, then reply with the single word OK.`,
    );
    return { taskId: spawned(lab, out, `task spawn ${label} ${i + 1}`), stdout: out.stdout };
  });

/** A session stopping frees its slot (hub/slots STOPPED). */
const THREAD_STOPS = ["thread.completed", "thread.failed", "thread.interrupted", "thread.waiting", "thread.usage_limited"];
/** The events maxConcurrent replays. */
const RUN_EVENTS = ["task.started", "thread.started", ...TASK_ENDS, ...THREAD_STOPS];
/**
 * The most agents of `tasks` running at once, replayed in hub order. An agent stops running when its session stops
 * (its thread's stop event, which frees the slot) or its task ends, whichever comes first: the task.completed that
 * books the result comes after the hub has read the thread's changes, so the next agent may already hold the slot.
 * A later run of the task's thread (a message, a continue) takes a slot again, so its thread.started counts as live.
 */
const maxConcurrent = (events: ReadonlyArray<Body>, tasks: ReadonlyArray<Body>) => {
  const ofThread = new Map(tasks.filter((t) => t.threadRef?.threadId).map((t) => [t.threadRef.threadId as string, t.taskId as string]));
  const ids = new Set(tasks.map((t) => t.taskId as string));
  const live = new Set<string>();
  let max = 0;
  for (const e of events.toSorted((a, b) => a.seq - b.seq)) {
    const id = (e.data?.taskId as string | undefined) ?? (typeof e.threadId === "string" ? ofThread.get(e.threadId) : undefined);
    if (id === undefined || !ids.has(id)) continue;
    if (e.type === "task.started" || e.type === "thread.started") max = Math.max(max, live.add(id).size);
    else if (TASK_ENDS.includes(e.type) || THREAD_STOPS.includes(e.type)) live.delete(id);
  }
  return max;
};

type ChatMessage = Body & { readonly seq: number; readonly author: "human" | "lead" | "system"; readonly text: string; readonly item?: Body; readonly history?: string };

/**
 * One project's chat as a person sees it, with their key: send, read every message, wait for the lead's answer, and
 * find an inline item.
 */
const chatOf = (lab: Lab, humanCall: Lab["callTool"], ref: Ref, need: (tool: string) => void) => {
  const page = async (args: Body) => {
    need("chat_history");
    const out = await humanCall("chat_history", { projectRef: ref, limit: 100, ...args });
    lab.check(!out.isError, `chat_history: ${JSON.stringify(out.body)}`);
    return out.body as { messages: Array<ChatMessage>; moreBefore: boolean; moreAfter: boolean; state: Body };
  };
  const history = async (): Promise<Array<ChatMessage>> => {
    let p = await page({});
    const all = [...p.messages];
    while (p.moreBefore && all.length > 0) {
      p = await page({ before: all[0]!.seq });
      all.unshift(...p.messages);
    }
    return all;
  };
  const after = async (seq: number): Promise<Array<ChatMessage>> => {
    const all: Array<ChatMessage> = [];
    for (let from = seq; ; ) {
      const p = await page({ after: from });
      all.push(...p.messages);
      if (!p.moreAfter || p.messages.length === 0) return all;
      from = p.messages.at(-1)!.seq;
    }
  };
  const state = async () => (await page({ limit: 1 })).state;
  const chatEvent = (e: Body) => (e.type === "chat.message" || e.type === "chat.waiting") && sameProject(e.data?.projectRef, ref);
  /** Sends `text` as the person: the chat's last seq and the event cursor from just before it. */
  const send = async (text: string) => {
    need("chat_send");
    const cursor = await lab.cursor();
    const seq = (await state()).lastSeq as number;
    const sent = await humanCall("chat_send", { projectRef: ref, text, clientRequestId: randomUUID() });
    lab.check(!sent.isError, `chat_send: ${JSON.stringify(sent.body)}`);
    lab.log(`person → lead: ${text.length > 160 ? `${text.slice(0, 160)}…` : text}${sent.body.leadWaiting ? ` (${sent.body.leadWaiting})` : ""}`);
    return { cursor, seq };
  };
  /**
   * The lead's messages after `seq`, once it has answered: it is not working, a final lead message is in, and the
   * chat stays quiet for 15 s (another wake may follow at once).
   */
  const reply = async (since: { cursor: number; seq: number }, what: string, ms = TURN_MS) => {
    const deadline = Date.now() + ms;
    let cursor = since.cursor;
    for (;;) {
      const st = await state();
      const lead = (await after(since.seq)).filter((m) => m.author === "lead" && m.state === "final");
      if (st.leadWorking !== true && lead.length > 0) {
        const more = await lab.waitEvent("the chat stays quiet", 15_000, { cursor, match: chatEvent }).catch(() => undefined);
        if (more === undefined) {
          lab.log(`lead → person: ${lead.map((m) => m.text || m.item?.kind).join(" ¶ ").slice(0, 500)}`);
          return lead;
        }
        cursor = more.cursor;
        continue;
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        const tail = (await after(since.seq)).map((m) => `${m.author}: ${String(m.text || m.item?.kind).slice(0, 120)}`);
        throw new Error(`timed out after ${ms / 1000}s waiting for the lead's answer (${what}); the chat since: ${JSON.stringify(tail)}`);
      }
      const next = await lab.waitEvent(`the lead's answer: ${what}`, Math.min(left, 60_000), { cursor, match: chatEvent }).catch(() => undefined);
      if (next !== undefined) cursor = next.cursor;
    }
  };
  /** The first message after `seq` whose inline item satisfies `pred`, waiting on chat events up to `ms`. */
  const item = async (seq: number, cursor: number, what: string, ms: number, pred: (item: Body) => boolean) => {
    const deadline = Date.now() + ms;
    for (let from = cursor; ; ) {
      const hit = (await after(seq)).find((m) => m.item !== undefined && pred(m.item));
      if (hit !== undefined) return hit;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out after ${ms / 1000}s: ${what}`);
      const next = await lab.waitEvent(what, Math.min(left, 60_000), { cursor: from, match: chatEvent }).catch(() => undefined);
      if (next !== undefined) from = next.cursor;
    }
  };
  const leadThread = async () => (((await lab.callTool("project_get", ref)).body.lead as Body | undefined)?.threadId as string | undefined);
  return { history, after, state, send, reply, item, leadThread };
};
type Chat = ReturnType<typeof chatOf>;


export async function chatLead(lab: Lab) {
  const { callTool, check, ok, log } = lab;
  const parts = wanted();
  const on = (p: Part) => parts.has(p);
  await lab.waitLive(LEAD_MACHINE);
  await lab.waitLive(WORK_MACHINE);

  // A missing tool fails the part that needs it, naming the slice that brings it.
  const hubTools = new Set(await (async () => {
    const { client } = await mcpWith(lab.hubUrl, lab.key);
    try {
      return (await client.listTools()).tools.map((t) => t.name);
    } finally {
      await client.close().catch(() => undefined);
    }
  })());
  const need = (tool: string) => check(hubTools.has(tool), `this build has no ${tool} (${TOOL_FROM[tool] ?? "a hub slice"} brings it)`);

  const failures: Array<string> = [];
  /** Runs one part; a failure is recorded and the next part still runs, so one run reports every broken piece. */
  const part = async (name: Part, fn: () => Promise<void>) => {
    if (!on(name)) return;
    log(`--- chat: ${name}`);
    try {
      await fn();
      ok(`chat: ${name} passed`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${name}: ${message}`);
      log(`FAIL chat: ${name}: ${message}`);
    }
  };
  const labRepo = LAB_REPO_PARTS.some(on);

  try {
    if (labRepo) {
      requireGhLogin();
      check(NAMESPACE.startsWith("slot/"), `chat needs CI: run it in a slot/<n> namespace, not ${NAMESPACE}`);
      checkClone(check);
      resetNamespace();
      prepareCheckout(LAB_REPO_POLICY);
      ok(`${CLONE} at origin/${BASE}; untracked policy (area all); ${NAMESPACE}/ on ${REPO} reset to the seed`);
      const thaw = await callTool("train_freeze", { repo: REPO, frozen: false });
      log(`train_freeze false: ${thaw.isError ? JSON.stringify(thaw.body) : "ok"}`);
      const projectId = await lab.addProject(LEAD_MACHINE, CLONE, "fleetd-lab");
      const ref = { machineId: LEAD_MACHINE, projectId };
      const chat = chatOf(lab, lab.humanCall, ref, need);
      const fleetd = shellIn(LEAD_MACHINE, CLONE);

      await part("work", () => workPart(lab, chat, ref));
      await part("terse", () => tersePart(lab, chat, ref));
      await part("secret", () => secretPart(lab, chat, ref, lab.humanCall, need));
      await part("gated", () => gatedPart(lab, chat, ref, lab.humanCall, need));
      await part("build", () => buildPart(lab, chat, ref));
      await part("fixes", () => fixesPart(lab, chat, ref, fleetd));
      await part("cap1", () => cap1Part(lab, ref, fleetd, need));
      await part("tools", async () => {
        // Run alone, no part has talked to the lead yet: start it, so its session's tools can be read.
        if ((await chat.leadThread()) === undefined) {
          const from = await lab.cursor();
          const started = await callTool("lead_start", { ...ref, ...SHIPPED });
          check(!started.isError, `lead_start: ${JSON.stringify(started.body)}`);
          await lab.waitEvent("the lead's start turn", TURN_MS, { cursor: from, machineId: LEAD_MACHINE, match: (e) => e.threadId === started.body.threadId && ENDED.includes(e.type) });
        }
        await toolsPart(lab, chat, hubTools);
      });
      await part("plain", async () => {
        const lead = (await chat.history()).filter((m) => m.author === "lead" && m.history === undefined && m.text !== "");
        check(lead.length > 0, "the lead wrote in chat");
        const leaky = lead.filter((m) => INTERNAL_ID.test(m.text));
        check(leaky.length === 0, `lead messages carry no internal ids: ${JSON.stringify(leaky.map((m) => m.text.slice(0, 200)))}`);
        ok(`${lead.length} lead messages, none with an internal id`);
      });
    }
    await part("history", () => historyPart(lab));
    if (on("areas")) {
      seedLocalRepo(LOCAL_REPO, DEFAULTS);
      const projectId = await lab.addProject(WORK_MACHINE, LOCAL_REPO, "repo-chat");
      await part("areas", () => areasPart(lab, { machineId: WORK_MACHINE, projectId }));
    }
    if (on("cap")) {
      seedLocalRepo(CAP_REPO, LAB_REPO_POLICY);
      const projectId = await lab.addProject(WORK_MACHINE, CAP_REPO, "repo-cap");
      const ref = { machineId: WORK_MACHINE, projectId };
      await part("cap", () => capPart(lab, chatOf(lab, lab.humanCall, ref, need), ref, need));
    }
    check(failures.length === 0, `${failures.length} chat part(s) failed:\n  ${failures.join("\n  ")}`);
  } finally {
    if (labRepo) {
      // Only this slot's namespace, never the repo's main.
      resetNamespace();
      await removeLabRepoProject(lab).catch((error: unknown) => log(`could not remove the lab repo project: ${String(error)}`));
      fs.rmSync(path.join(CLONE, ".fleetd"), { recursive: true, force: true });
    }
  }
}

// ---- work: a chat message becomes a merged PR ----
async function workPart(lab: Lab, chat: Chat, ref: Ref) {
  const { check, ok } = lab;
  const file = `${DIR}/hello.md`;
  const sent = await chat.send(`Please add ${file} with the single line "hello from chat". One small PR is plenty.`);
  const writer = await nextTask(lab, ref, sent.cursor, "the lead starts a writer for the hello request", TURN_MS * 2, (t) => t.kind === "write");
  ok(`the lead started a writer: "${writer.task.title}"`);
  const merged = await lab.waitEvent(`a PR adding ${file} merges through the train`, CI_MS + TURN_MS * 3, { cursor: sent.cursor, types: ["pr.merged"], match: (e) => e.data?.repo === REPO });
  const onMain = spawnSync("gh", ["api", onBase(file), "--silent"], { cwd: LAB, env: scrubbedEnv() }).status === 0;
  check(onMain, `${file} is on ${BASE} after PR #${merged.event.data.prNumber} merged`);
  ok(`chat message → writer → PR #${merged.event.data.prNumber} merged by the train; ${file} is on ${BASE}`);
}

// ---- terse: numbered questions with a rec; "1 go" ----
async function tersePart(lab: Lab, chat: Chat, ref: Ref) {
  const { check, ok } = lab;
  const file = `${DIR}/digest.md`;
  const sent = await chat.send(
    `Next, add ${file}: one line saying which day the weekly usage digest email goes out. I haven't picked the day and it's my call, so ask me before you build it.`,
  );
  // The person answers whatever the checks below find, so no part after this one inherits an open question.
  // The answer's checks run even when the asking ones failed, so one run reports both halves.
  let asked: unknown;
  await askedPart(lab, chat, ref, sent).catch((error: unknown) => (asked = error));
  const answered = await chat.send("1 go");
  // The reply clears needs-you at once: the person answered, whatever the lead does next.
  const repliedAt = Date.now();
  const cleared = await lab
    .until("needs-you clears after the reply", NEEDS_YOU_CLEARS_MS, async () =>
      (await chat.state()).needsYou !== true ? Date.now() - repliedAt : (await new Promise((r) => setTimeout(r, 100)), undefined),
    )
    .catch(() => undefined);
  try {
    lab.check(cleared !== undefined, `needs-you cleared within ${NEEDS_YOU_CLEARS_MS} ms of the reply`);
    lab.ok(`needs-you off ${cleared} ms after "1 go"`);
    await answeredPart(lab, chat, ref, answered, file);
  } catch (error) {
    if (asked === undefined) throw error;
    throw new Error(`${String(asked instanceof Error ? asked.message : asked)}; and after "1 go": ${error instanceof Error ? error.message : String(error)}`);
  }
  if (asked !== undefined) throw asked;
}

async function askedPart(lab: Lab, chat: Chat, ref: Ref, sent: { cursor: number; seq: number }) {
  const { check, ok } = lab;
  const said = await chat.reply(sent, "the digest question");
  const asking = said.find((m) => /^\s*1[.)]\s/mu.test(m.text));
  check(asking, `the lead asks as numbered items: ${JSON.stringify(said.map((m) => m.text))}`);
  const items = asking!.text.split("\n").filter((l) => /^\s*\d+[.)]\s/u.test(l));
  // A recommendation in the item's own line, in the lead's words ("Rec: …", "I'd suggest …", "I recommend …").
  const bare = items.filter((l) => !RECOMMENDS.test(l));
  check(bare.length === 0, `every numbered question carries a recommendation: ${JSON.stringify(bare)}`);
  check((await chat.state()).needsYou === true, "needs-you is on while the lead waits for the answer");
  const noWrite = (await tasksOf(lab, ref)).filter((t) => t.kind === "write" && ["queued", "running"].includes(t.state) && String(t.title).toLowerCase().includes("digest"));
  check(noWrite.length === 0, `nothing built before the answer: ${JSON.stringify(noWrite.map((t) => t.title))}`);
  ok(`${items.length} numbered question(s) with a recommendation; needs-you on`);
}

async function answeredPart(lab: Lab, chat: Chat, ref: Ref, answered: { cursor: number; seq: number }, file: string) {
  const { check, ok } = lab;
  const writer = await nextTask(lab, ref, answered.cursor, `a writer for ${file} after "1 go"`, TURN_MS * 2, (t) => t.kind === "write");
  await chat.reply(answered, "the terse answer");
  check((await chat.state()).needsYou !== true, "needs-you is off once the person answered");
  const go = (await chat.after(answered.seq)).find((m) => m.author === "human" && m.text === "1 go");
  check(go, `the "1 go" message is in the chat`);
  const found = [
    ...(((await lab.callTool("decisions_search", { query: "digest" })).body.decisions as Array<Body>) ?? []),
    ...(((await lab.callTool("decisions_search", { query: "day" })).body.decisions as Array<Body>) ?? []),
  ];
  // Logged from the answer: after the person's "1 go", not a guess made before it.
  const decisions = found.filter((d) => Date.parse(d.at) >= Date.parse(go!.createdAt as string));
  check(decisions.length > 0, `the lead logged the answer with decide after "1 go" (${go!.createdAt}): ${JSON.stringify(found.map((d) => [d.key, d.value, d.at]))}`);
  // Never the same question twice.
  const later = (await chat.after(answered.seq)).filter((m) => m.author === "lead" && /^\s*1[.)]\s/mu.test(m.text) && /digest|day/iu.test(m.text));
  check(later.length === 0, `the lead does not ask again: ${JSON.stringify(later.map((m) => m.text))}`);
  ok(`"1 go" → decision ${decisions[0]!.key} = ${decisions[0]!.value}; writer "${writer.task.title}" started; not asked again`);
}

// ---- secret: an inline secret item; the value is in no chat message ----
async function secretPart(lab: Lab, chat: Chat, ref: Ref, humanCall: Lab["callTool"], need: (t: string) => void) {
  const { check, ok } = lab;
  need("secret_submit");
  const value = `lab-chat-secret-${createHash("sha256").update(randomUUID()).digest("hex").slice(0, 24)}`;
  fs.mkdirSync(lab.dir, { recursive: true });
  const sink = path.join(lab.dir, "secret.env");
  fs.writeFileSync(sink, "OTHER=1\n");
  const sent = await chat.send(
    `For a later step I need the lab API key. Request it from me as a secret with request_secret (key lab.api_key, sink env:${ref.machineId}:${sink}, envName LAB_API_KEY). Don't ask me to paste it here.`,
  );
  const msg = await chat.item(sent.seq, sent.cursor, "the inline secret item", TURN_MS, (i) => i.kind === "secret_request");
  const item = msg.item!;
  check(item.name === "lab.api_key" && item.state === "open" && msg.text === "", `the secret item: ${JSON.stringify(msg)}`);
  check((await chat.state()).needsYou === true, "needs-you is on while the secret item is open");
  ok(`inline secret item ${item.requestId} (${item.name} → ${item.sink})`);

  const machine = ((await lab.callTool("fleetd_status")).body.machines as Array<Body>).find((m) => m.machineId === ref.machineId);
  check(typeof machine?.boxPubKey === "string", `${ref.machineId} has a box key`);
  await sodium.ready;
  const sealed = sodium.to_base64(
    sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(machine!.boxPubKey, sodium.base64_variants.ORIGINAL)),
    sodium.base64_variants.ORIGINAL,
  );
  const refused = await lab.callTool("secret_submit", { requestId: item.requestId, sealed });
  check(refused.isError, `an agent key cannot fill a secret: ${JSON.stringify(refused.body)}`);
  const cursor = await lab.cursor();
  const saved = await humanCall("secret_submit", { requestId: item.requestId, sealed });
  check(!saved.isError, `secret_submit: ${JSON.stringify(saved.body)}`);
  const stored = await chat.item(sent.seq, cursor, "the secret item turns stored", 60_000, (i) => i.requestId === item.requestId && i.state === "stored");
  const fingerprint = createHash("sha256").update(value).digest("hex").slice(0, 8);
  check(String(stored.item!.fingerprint ?? "").includes(fingerprint), `the item shows only the fingerprint: ${JSON.stringify(stored.item)}`);
  check(fs.readFileSync(sink, "utf8").includes(`LAB_API_KEY=${value}`), "the sink holds the value");
  // The lead hears the outcome in its next wake ("- Q<n> secret lab.api_key: stored on …"); its answer settles first.
  await chat.reply({ cursor, seq: stored.seq }, "the secret stored wake").catch(() => undefined);
  const leadId = await chat.leadThread();
  const wake = userMessages(ref.machineId, leadId ?? "").flatMap((t) => t.split("\n")).find((l) => l.startsWith(`- ${item.requestId} secret lab.api_key: stored`));
  check(wake, `the lead's wake carries the outcome: ${JSON.stringify(userMessages(ref.machineId, leadId ?? "").at(-1)?.slice(-400))}`);
  ok(`the lead's wake: ${wake}`);

  const hist = JSON.stringify(await chat.history());
  check(!hist.includes(value) && !hist.includes(sealed), "the value is in no chat message");
  const events = JSON.stringify(await eventsSince(lab, 0));
  check(!events.includes(value) && !events.includes(sealed), "the value is in no event");
  const threadId = await chat.leadThread();
  check(threadId === undefined || !sessionText(ref.machineId, threadId).includes(value), "the value is in no lead transcript");
  // Every file the run wrote but the sink: hub home, node homes (transcripts, claude session files), every process log.
  const places = [...filesUnder(lab.hubHome), ...filesUnder(path.join(RUN, "logs")), ...lab.machines.flatMap((m) => filesUnder(machineHome(m.id)))].filter(([f]) => f !== sink);
  const hits = places.filter(([, text]) => text.includes(value) || text.includes(sealed)).map(([f]) => f);
  check(hits.length === 0, `the value is in no file but its sink: ${hits.join(", ")}`);
  check((await chat.state()).needsYou !== true, "needs-you is off once the secret is stored");
  ok(`stored through the inline item; the value is in no chat message, event or wake, and in none of ${places.length} files (hub, nodes, logs)`);
}

// ---- gated: nothing runs before Approve ----
async function gatedPart(lab: Lab, chat: Chat, ref: Ref, humanCall: Lab["callTool"], need: (t: string) => void) {
  const { check, ok } = lab;
  need("approval_answer");
  fs.mkdirSync(lab.dir, { recursive: true });
  const marker = path.join(lab.dir, "gated.txt");
  fs.rmSync(marker, { force: true });
  // Appends, so a second run would show.
  const argv = ["sh", "-c", `echo gated >> ${marker}`];
  const sent = await chat.send(
    `Run this exact command as a gated command (gated_run, class irreversible, reason "chat lab"): ${JSON.stringify(argv)}. Wait for my approval; don't run it any other way.`,
  );
  const msg = await chat.item(sent.seq, sent.cursor, "the inline gated command", TURN_MS, (i) => i.kind === "command_approval");
  const item = msg.item!;
  check(JSON.stringify(item.gated?.argv) === JSON.stringify(argv) && item.state === "open", `the item shows the exact command, open: ${JSON.stringify(item)}`);
  await chat.reply(sent, "the gated request").catch(() => undefined);

  // Held: nothing runs while nobody approves, and an agent key cannot approve.
  await new Promise((r) => setTimeout(r, 10_000));
  const byAgent = await lab.callTool("approval_answer", { requestId: item.requestId, decision: "approve" });
  check(byAgent.isError, `an agent key cannot approve: ${JSON.stringify(byAgent.body)}`);
  const held = (await chat.history()).find((m) => m.item?.requestId === item.requestId)?.item;
  check(held?.state === "open" && !fs.existsSync(marker), `still open and not run before Approve: ${JSON.stringify(held)}`);
  check((await chat.state()).needsYou === true, "needs-you is on while the command waits");
  ok(`held ${item.requestId} for 10 s and an agent key's approve: still open, nothing ran`);

  const cursor = await lab.cursor();
  const approved = await humanCall("approval_answer", { requestId: item.requestId, decision: "approve" });
  check(!approved.isError, `approval_answer: ${JSON.stringify(approved.body)}`);
  const ran = await chat.item(sent.seq, cursor, "the approved command ran", 60_000, (i) => i.requestId === item.requestId && ["ran", "failed"].includes(i.state));
  check(ran.item!.state === "ran" && ran.item!.exitCode === 0 && fs.readFileSync(marker, "utf8") === "gated\n", `ran once approved: ${JSON.stringify(ran.item)}`);
  ok(`approved by a person: ${item.requestId} ran, exit 0`);
  // A second approve is refused (one answer counts), and the command ran exactly once.
  const again = await humanCall("approval_answer", { requestId: item.requestId, decision: "approve" });
  check(again.isError, `a second approve is refused: ${JSON.stringify(again.body)}`);
  await chat.reply({ cursor, seq: ran.seq }, "the gated result wake").catch(() => undefined);
  check(fs.readFileSync(marker, "utf8") === "gated\n", `the command ran exactly once: ${JSON.stringify(fs.readFileSync(marker, "utf8"))}`);
  const leadId = await chat.leadThread();
  const wake = userMessages(ref.machineId, leadId ?? "").flatMap((t) => t.split("\n")).find((l) => l.startsWith(`- ${item.requestId} your command`));
  check(wake, `the lead's next wake carries the outcome: ${JSON.stringify(userMessages(ref.machineId, leadId ?? "").at(-1)?.slice(-400))}`);
  check((await chat.state()).needsYou !== true, "needs-you is off once the command ran");
  ok(`ran exactly once; the lead's wake: ${wake}; needs-you off`);
}

// ---- build: bug (a), a research result that offers a build, then "build it" ----
async function buildPart(lab: Lab, chat: Chat, ref: Ref) {
  const { check, ok } = lab;
  const file = `${DIR}/faq.md`;
  const sent = await chat.send(
    `Research first: would a short FAQ page at ${file} help this repo? Have one read-only research agent look and tell me what you recommend. Don't build anything until I say.`,
  );
  const research = await nextTask(lab, ref, sent.cursor, "a research agent starts", TURN_MS * 2);
  check(research.task.kind !== "write", `the first agent only researches: ${research.task.kind}`);
  const end = await lab.waitEvent("the research agent ends", TURN_MS * 2, { cursor: research.cursor, types: TASK_ENDS, match: (e) => e.data?.taskId === research.task.taskId });
  check(end.event.type === "task.completed", `the research agent completed: ${end.event.summary}`);
  const offer = await chat.reply({ cursor: end.cursor, seq: (await chat.state()).lastSeq as number }, "the research result", TURN_MS * 2);
  check(offer.some((m) => /\bbuild\b/iu.test(m.text)), `the lead offers the build: ${JSON.stringify(offer.map((m) => m.text))}`);
  const workstreamId = research.task.workstreamId as string | undefined;

  const answered = await chat.send("build it");
  const writer = await nextTask(lab, ref, answered.cursor, `a writer starts for ${file} after "build it"`, TURN_MS * 2, (t) => t.kind === "write");
  await chat.reply(answered, "the build answer");
  // The answer was not swallowed: the order the build runs in (the research one amended, or a new one) closes only
  // after the build's writer started. The research order may close on its own verdict before the offer.
  const buildOrder = writer.task.workstreamId as string;
  const early = (await eventsSince(lab, answered.cursor, ["workstream.done"])).filter((e) => e.data?.workstreamId === buildOrder && e.seq < writer.seq);
  check(early.length === 0, `${buildOrder} closed before its build started: ${JSON.stringify(early.map((e) => e.summary))}`);
  const how = buildOrder === workstreamId ? "on the research order (brief amended)" : "as a new order";
  ok(`research agent → offer → "build it" → writer "${writer.task.title}" ${how}, which stays open until the build ran`);
}

// ---- fixes: bug (b), W1/T4: review fixes survive a workstream closing ----
async function fixesPart(lab: Lab, chat: Chat, ref: Ref, fleetd: Shell) {
  const { check, ok } = lab;
  // A done-when that takes a while, so a fix can be filed while the claim runs (W1's timing).
  const slow = [{ type: "cmd", machineId: ref.machineId, argv: ["sleep", "20"], expectExit: 0 }];
  const spawnFix = (w: string, title: string) =>
    spawned(
      lab,
      fleetd(
        "task", "spawn", "--workstream", w, "--title", title, "--kind", "write", "--serves", `defect: ${title}`, "--areas", "all", "--model", MECHANICS.model, "--effort", MECHANICS.effort,
        "--prompt", "Your first tool call must be your Bash tool running exactly `sleep 90`; wait the full 90 seconds for it to finish. Then reply with the single word OK. Change no files.",
      ),
      `spawn the fix "${title}"`,
    );
  const workstreamState = async (w: string) => (await lab.callTool("workstream_get", { workstreamId: w })).body.workstream?.state as string | undefined;

  // A. A claim while a fix is open is refused, and the fix keeps running. Its done-when passes at once, so the
  // close-over below concludes while the fix still runs.
  const wa = await quietOrder(lab, ref, fleetd, "chat lab: a claim with a fix open", [{ type: "cmd", machineId: ref.machineId, argv: ["true"], expectExit: 0 }]);
  let from = await lab.cursor();
  const ta = spawnFix(wa, "share link goes stale");
  const refused = fleetd("claim", "done", "--workstream", wa);
  const said = `${refused.stdout}${refused.stderr}`;
  check(
    refused.code !== 0 &&
      said.includes(`${wa} has write work that hasn't landed: "share link goes stale"`) &&
      said.includes(`(ids, for tools only: ${ta})`) &&
      said.includes("It is done only once that lands."),
    `claim_done refused while ${ta} is open: ${JSON.stringify(refused)}`,
  );
  check((await workstreamState(wa)) === "running", `the workstream stays running: ${await workstreamState(wa)}`);
  check((await eventsSince(lab, from, ["task.cancelled"])).every((e) => e.data?.taskId !== ta), `${ta} is not cancelled by the refusal`);
  ok(`A. claim_done refused: ${said.trim().split("\n")[0]}`);
  // The one deliberate way out: closing over the fix, which says what it drops.
  from = await lab.cursor();
  const over = await shellAsync(ref.machineId, CLONE, "claim", "done", "--workstream", wa, "--close-over", "lab: the fix is not needed");
  check(over.code === 0, `claim done --close-over: exit ${over.code}: ${over.text.trim().split("\n")[0]}`);
  const closed = await lab.waitEvent(`${wa} closed on purpose`, 60_000, { cursor: from, types: ["workstream.done"], match: (e) => e.data?.workstreamId === wa });
  check(String(closed.event.data.reason).startsWith("closed on purpose: lab: the fix is not needed") && String(closed.event.data.reason).includes('"share link goes stale"'), `the close names what it drops: ${JSON.stringify(closed.event.data)}`);
  const dropped = await lab.waitEvent(`${ta} cancelled by the close`, 30_000, { cursor: from, types: ["task.cancelled"], match: (e) => e.data?.taskId === ta });
  const why = String((await taskGet(lab, ta)).result?.tail ?? "");
  check(dropped.event.seq > closed.event.seq && /^Cancelled: .* was closed on purpose/u.test(why), `the cancel came with the close and says why: ${why}`);
  ok(`A. closed on purpose (${over.text.trim().split("\n")[0]}); ${ta} cancelled with the reason`);

  // B. The claim is already verifying when the fix is filed: it passes, but the workstream stays open.
  const wb = await quietOrder(lab, ref, fleetd, "chat lab: a fix filed during the claim", slow);
  from = await lab.cursor();
  const claiming = shellAsync(ref.machineId, CLONE, "claim", "done", "--workstream", wb);
  // The check sleeps 20 s; the fix is filed while it runs.
  await lab.until(`${wb} verifying its claim`, 15_000, async () =>
    (await workstreamState(wb)) === "verifying" ? true : (await new Promise((r) => setTimeout(r, 250)), undefined),
  );
  const tb = spawnFix(wb, "flag unpriced tokens");
  const stays = await lab.waitEvent(`${wb} stays open with ${tb} open`, 120_000, {
    cursor: from,
    types: ["workstream.state"],
    match: (e) => e.data?.workstreamId === wb && e.data?.state === "running" && /work that hasn't landed is still open/u.test(String(e.data?.reason)),
  });
  await claiming;
  check(String(stays.event.data.reason).includes('"flag unpriced tokens"') && String(stays.event.summary).startsWith(`${wb} stays open:`), `the hold names the fix: ${JSON.stringify(stays.event)}`);
  const between = await eventsSince(lab, from, ["workstream.done", "claim.passed", "task.cancelled"]);
  const swallowed = between.filter((e) => (e.data?.workstreamId === wb && e.type !== "task.cancelled") || e.data?.taskId === tb);
  check(swallowed.length === 0, `no workstream.done, claim.passed or cancel of ${tb}: ${JSON.stringify(swallowed.map((e) => e.summary))}`);
  check((await taskGet(lab, tb)).state !== "cancelled", `${tb} is not cancelled`);
  ok(`B. ${stays.event.summary}`);
  // The lead hears it and should say so in chat: its own words, so only logged.
  try {
    const told = await chat.reply({ cursor: stays.cursor, seq: (await chat.state()).lastSeq as number }, "the lead on the open fix", 60_000);
    lab.log(`${told.some((m) => /fix/iu.test(m.text)) ? "the lead said" : "note: the lead did not mention the fix"}: ${told.map((m) => m.text).join(" ").slice(0, 200)}`);
  } catch (error) {
    lab.log(`note: no lead chat line on the open fix: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
  }

  // Then the fix is dropped on purpose, and the next claim closes the workstream.
  // Dropped on purpose if it still runs; one that finished has landed nothing to drop.
  if (["queued", "running", "idle"].includes((await taskGet(lab, tb)).state)) check(fleetd("task", "cancel", tb).code === 0, `a visible, intentional drop of ${tb}`);
  from = await lab.cursor();
  const again = await shellAsync(ref.machineId, CLONE, "claim", "done", "--workstream", wb);
  lab.log(`claim again: ${again.text.trim().split("\n")[0]}`);
  await lab.waitEvent(`${wb} done once no fix is open`, 120_000, { cursor: from, types: ["workstream.done"], match: (e) => e.data?.workstreamId === wb });
  ok(`${wb} done once its fix was dropped on purpose`);
}

// ---- cap1: at max agents 1, the review that gates a merge goes first ----
async function cap1Part(lab: Lab, ref: Ref, fleetd: Shell, need: (t: string) => void) {
  const { check, ok } = lab;
  need("cap_set");
  const setMax = async (n: number) => {
    const set = await lab.callTool("cap_set", { project: { projectRef: ref, maxAgents: n } });
    check(!set.isError, `cap_set ${n}: ${JSON.stringify(set.body)}`);
  };
  const file = `${DIR}/cap1.md`;
  // Tier M: its PR needs a review before the train merges it, so the review is what gates the merge.
  const onMain = { type: "cmd", machineId: ref.machineId, argv: ["gh", "api", onBase(file), "--silent"], expectExit: 0 };
  const w = await quietOrder(lab, ref, fleetd, `chat lab: add ${file} at max agents 1`, [onMain], "M");
  // Earlier parts' agents (the lead's own work) finish first, so nothing but this part's agents holds a slot or a lease.
  await lab.until("the project's earlier agents finish", TURN_MS * 3, async () =>
    (await tasksOf(lab, ref)).some((t) => ["queued", "running"].includes(t.state)) ? (await new Promise((r) => setTimeout(r, 2_000)), undefined) : true,
  );
  await setMax(1);
  try {
    const from = await lab.cursor();
    const writer = spawned(
      lab,
      fleetd(
        "task", "spawn", "--workstream", w, "--title", "add cap1.md", "--areas", "all", "--serves", "done:0", "--model", MECHANICS.model, "--effort", MECHANICS.effort,
        "--prompt",
        `Do these steps in order. 1. Create the file ${file} (from the repo root) containing exactly one line: cap one. Commit it with the message "add ${file}". ` +
          `2. Push your branch and open the pull request as your rules say, with the title "add ${file}" and the body exactly "Source: done:0". ` +
          `3. Call the report tool with kind "slice_ready" and prUrl set to that PR's URL. 4. Run \`sleep 30\` with your Bash tool and wait for it. 5. Reply with the PR URL.`,
      ),
      "spawn the writer",
    );
    // Queued while the writer runs and before the review exists: plain order would start it first when the slot frees.
    await lab.waitEvent(`${writer} starts`, TURN_MS, { cursor: from, types: ["task.started"], match: (e) => e.data?.taskId === writer });
    const [waiter] = spawnSleepers(lab, fleetd, w, "waits at cap 1", 1, 5);
    check((await taskGet(lab, waiter!.taskId)).state === "queued", `${waiter!.taskId} waits behind ${writer} at max agents 1`);
    const writerEnd = await lab.waitEvent(`${writer} ends`, TURN_MS * 2, { cursor: from, types: TASK_ENDS, match: (e) => e.data?.taskId === writer });
    const review = await nextTask(lab, ref, from, `the review of ${writer}'s PR starts`, CI_MS + TURN_MS * 2, (t) => t.kind === "review");
    const seen = await eventsSince(lab, from, ["task.queued", "task.started"]);
    const reviewQueued = seen.find((e) => e.type === "task.queued" && e.data?.taskId === review.task.taskId);
    check(
      reviewQueued !== undefined && reviewQueued.seq < writerEnd.event.seq,
      `the review was waiting when ${writer}'s slot freed (queued at ${reviewQueued?.seq}, ${writer} ended at ${writerEnd.event.seq}); without that, the writer did not report slice_ready and the order isn't tested`,
    );
    const waiterStart = seen.find((e) => e.type === "task.started" && e.data?.taskId === waiter!.taskId);
    check(waiterStart === undefined || waiterStart.seq > review.seq, `the gating review (started seq ${review.seq}) went before the agent queued earlier (started seq ${waiterStart?.seq})`);
    const merged = await lab.waitEvent(`${writer}'s PR merges at max agents 1`, CI_MS + TURN_MS * 3, { cursor: from, types: ["pr.merged"], match: (e) => e.data?.repo === REPO });
    await lab.waitEvent(`${waiter!.taskId} ends`, TURN_MS * 2, { cursor: from, types: TASK_ENDS, match: (e) => e.data?.taskId === waiter!.taskId });
    const sessions = await eventsSince(lab, from, RUN_EVENTS);
    const max = maxConcurrent(sessions, (await tasksOf(lab, ref)).filter((t) => t.workstreamId === w));
    check(max <= 1, `at most one agent ran at once: ${max}`);
    ok(`max agents 1: review ${review.task.taskId} before ${waiter!.taskId}; PR #${merged.event.data.prNumber} merged; no deadlock`);
  } finally {
    await setMax(12).catch(() => undefined);
  }
}

// ---- tools: no ask anywhere ----
async function toolsPart(lab: Lab, chat: Chat, hubTools: ReadonlySet<string>) {
  const { check, ok } = lab;
  const gone = GONE_HUB_TOOLS.filter((t) => hubTools.has(t));
  check(gone.length === 0, `the hub lists no inbox or ask tools: ${gone.join(", ")}`);
  const sessions: Array<{ what: string; machineId: string; threadId: string }> = [];
  const lead = await chat.leadThread();
  if (lead !== undefined) sessions.push({ what: "lead", machineId: LEAD_MACHINE, threadId: lead });
  for (const machineId of [LEAD_MACHINE, WORK_MACHINE]) {
    for (const p of ((await lab.callTool("projects_list", { machineId })).body.projects as Array<Body>) ?? []) {
      for (const t of await tasksOf(lab, { machineId, projectId: p.projectId as string })) {
        if (t.threadRef?.threadId) sessions.push({ what: `${t.kind} agent`, machineId, threadId: t.threadRef.threadId as string });
      }
    }
  }
  const read = sessions.map((s) => ({ ...s, tools: initToolsOf(s.machineId, s.threadId) })).filter((s) => s.tools.length > 0);
  check(read.some((s) => s.what === "lead"), `the lead session's tools were read: ${JSON.stringify(sessions.map((s) => s.what))}`);
  const asking = read.filter((s) => s.tools.some((t) => ASK_TOOL.test(t)));
  check(asking.length === 0, `no session has an ask tool: ${JSON.stringify(asking.map((s) => [s.what, s.tools.filter((t) => ASK_TOOL.test(t))]))}`);
  const started = (await eventsSince(lab, 0, ["lead.started"])).filter((e) => e.threadId === lead).at(-1);
  const promptRef = String(started?.data?.promptRef ?? "");
  check(promptRef.startsWith("lead.start@") && promptRef !== OLD_LEAD_PROMPT, `the lead starts on the chat prompt, not ${OLD_LEAD_PROMPT}: ${JSON.stringify(started?.data)}`);
  const leadTools = read.find((s) => s.what === "lead")!.tools;
  check(leadTools.includes("mcp__fleetd__decide"), `the lead keeps decide: ${JSON.stringify(leadTools.filter((t) => t.startsWith("mcp__fleetd__")))}`);
  ok(`${read.length} sessions (${[...new Set(read.map((s) => s.what))].join(", ")}): no ask tool; the hub has none of ${GONE_HUB_TOOLS.join(", ")}; lead prompt ${promptRef}`);
}

// ---- history: orders from before the chat read back as history ----
/**
 * A pre-chat build (FLEETD_LAB_PRECHAT_BIN) runs a hub on a home of its own, with one project seeded as `project_add`
 * caches it (no node, no turns): a person places an order and adds a note. Then the build under test opens the same
 * home, as it would a user's live hub, and the project's chat must show them as history.
 */
async function historyPart(lab: Lab) {
  const { check, ok } = lab;
  const prechat = process.env.FLEETD_LAB_PRECHAT_BIN;
  check(
    prechat !== undefined && fs.existsSync(prechat),
    `set FLEETD_LAB_PRECHAT_BIN to a fleetd built before the chat (e.g. git worktree add /tmp/prechat 60067987 && cargo build --release there); got ${prechat}`,
  );
  const home = path.join(lab.dir, "history-hub");
  const url = `http://127.0.0.1:${HISTORY_PORT}`;
  const ref = { machineId: "lab-history", projectId: "history" };
  fs.rmSync(home, { recursive: true, force: true });
  const withHub = async <A>(bin: string | undefined, fn: (call: Lab["callTool"]) => Promise<A>) => {
    const own = process.env.FLEETD_HUB_BIN;
    if (bin !== undefined) process.env.FLEETD_HUB_BIN = bin;
    try {
      lab.startCli("hub-history", ["hub", "start", "--home", home, "--listen", `127.0.0.1:${HISTORY_PORT}`]);
    } finally {
      if (own === undefined) delete process.env.FLEETD_HUB_BIN;
      else process.env.FLEETD_HUB_BIN = own;
    }
    try {
      await lab.until("the history hub's /healthz", 30_000, async () => {
        const up = await fetch(`${url}/healthz`).then((r) => r.ok, () => false);
        if (!up) await new Promise((r) => setTimeout(r, 250));
        return up ? true : undefined;
      });
      const { client, callTool } = await mcpWith(url, key);
      try {
        return await fn(callTool);
      } finally {
        await client.close().catch(() => undefined);
      }
    } finally {
      await lab.stopCli("hub-history");
    }
  };

  // The pre-chat build makes the home (its key creates and migrates the db), then the project row is seeded.
  process.env.FLEETD_HUB_BIN = prechat;
  let key: string;
  try {
    const made = /fld_[a-z2-7]{20,}/u.exec(cli("hub", "key", "create", "--home", home, "--human", "--name", "history"))?.[0];
    check(made, "the pre-chat build created a human key");
    key = made!;
  } finally {
    delete process.env.FLEETD_HUB_BIN;
  }
  const db = new DatabaseSync(path.join(home, "hub.sqlite"));
  try {
    const at = new Date().toISOString();
    const row = { ...ref, title: "history", workspaceRoot: path.join(lab.dir, "history-ws"), threads: { running: 0, waiting: 0, idle: 0, failed: 0 }, lastActivityAt: at };
    db.prepare("INSERT INTO projects (machine_id, project_id, search, last_activity_at, data) VALUES (?, ?, ?, ?, ?)").run(ref.machineId, ref.projectId, "history", at, JSON.stringify(row));
  } finally {
    db.close();
  }

  const orderText = `Add a dark mode toggle to settings (${STAMP})`;
  await withHub(prechat, async (call) => {
    const placed = await call("intake_submit", { ...ref, text: orderText, clientRequestId: randomUUID() });
    check(!placed.isError, `the pre-chat build takes the order: ${JSON.stringify(placed.body)}`);
  });
  ok("pre-chat hub: an order placed by a person (a note would need a running lead, and this hub has no node)");

  await withHub(undefined, async (call) => {
    const page = await call("chat_history", { projectRef: ref, limit: 100 });
    check(!page.isError, `chat_history on the migrated home: ${JSON.stringify(page.body)}`);
    const history = (page.body.messages as Array<ChatMessage>).filter((m) => m.history !== undefined);
    const order = history.find((m) => m.history === "order" && m.author === "human" && m.text.includes(orderText));
    check(order, `the order reads back as history, the person's words: ${JSON.stringify(history.map((m) => [m.history, m.author, m.text.slice(0, 80)]))}`);
    const leaky = history.filter((m) => INTERNAL_ID.test(m.text));
    check(leaky.length === 0, `history carries no internal ids: ${JSON.stringify(leaky.map((m) => m.text.slice(0, 120)))}`);
    // Read again: nothing is added twice.
    const again = ((await call("chat_history", { projectRef: ref, limit: 100 })).body.messages as Array<ChatMessage>).filter((m) => m.history !== undefined);
    check(again.length === history.length, `a second read adds nothing (${history.length} then ${again.length})`);
    ok(`chat_history on the migrated home: the order as history (seq ${order!.seq}), no ids, stable on a second read`);
  });
}

// ---- areas: bug (c), inferred areas let two writers run at once ----
async function areasPart(lab: Lab, ref: Ref) {
  const { check, ok } = lab;
  // project_add of the same directory answers with its project and the inspect the add read.
  const added = await lab.callTool("project_add", { machineId: ref.machineId, path: LOCAL_REPO });
  check(!added.isError && added.body.projectId === ref.projectId, `project_add again: ${JSON.stringify(added.body)}`);
  const inspect = (added.body.inspect ?? {}) as Body;
  const areas = (inspect.areas as Array<string> | undefined) ?? [];
  check(inspect.areasInferred === true && ["a", "b", "all"].every((a) => areas.includes(a)), `areas inferred from the workspace: ${JSON.stringify({ areas, areasInferred: inspect.areasInferred })}`);
  ok(`inferred areas: ${areas.join(", ")}`);

  const fleetd = shellIn(ref.machineId, LOCAL_REPO);
  const w = openWorkstream(check, fleetd, "Two packages at once.");
  const from = await lab.cursor();
  const writer = (area: string) =>
    spawned(
      lab,
      fleetd(
        "task", "spawn", "--workstream", w, "--title", `note in ${area}`, "--areas", area, "--serves", `defect: package ${area} has no lab note`, "--model", MECHANICS.model, "--effort", MECHANICS.effort,
        "--prompt", `Run \`sleep 10\`, then append the line "chat lab" to packages/${area}/README.md and commit it with the message "chat lab: ${area}". Reply with the commit hash.`,
      ),
      `task spawn --areas ${area}`,
    );
  const [ta, tb] = [writer("a"), writer("b")];
  const ends = new Map<string, number>();
  for (const t of [ta, tb]) {
    const e = await lab.waitEvent(`${t} ends`, TURN_MS, { cursor: from, types: TASK_ENDS, match: (e) => e.data?.taskId === t });
    check(e.event.type === "task.completed", `${t} completed: ${e.event.summary}`);
    ends.set(t, e.event.seq as number);
  }
  const seen = await eventsSince(lab, from, ["task.queued", "task.started"]);
  const leaseWaits = seen.filter((e) => e.type === "task.queued" && /lease/u.test(String(e.data?.queuedReason)));
  check(leaseWaits.length === 0, `no writer waited on an area lease: ${JSON.stringify(leaseWaits.map((e) => e.summary))}`);
  const start = (t: string) => seen.find((e) => e.type === "task.started" && e.data?.taskId === t)?.seq as number | undefined;
  const firstEnd = Math.min(...ends.values());
  check((start(ta) ?? Infinity) < firstEnd && (start(tb) ?? Infinity) < firstEnd, `both started before either ended (starts ${start(ta)}, ${start(tb)}; first end ${firstEnd})`);
  ok(`${ta} (area a) and ${tb} (area b) ran at the same time`);
}

// ---- cap: the Max agents cap ----
async function capPart(lab: Lab, chat: Chat, ref: Ref, need: (t: string) => void) {
  const { check, ok } = lab;
  need("cap_set");
  const fleetd = shellIn(ref.machineId, CAP_REPO);
  let current: number | undefined;
  /** Sets the project's max agents; each change is one agents.cap event (setting the same value is none). */
  const setMax = async (n: number) => {
    check(n !== current, `max agents is already ${n}`);
    current = n;
    const from = await lab.cursor();
    const set = await lab.callTool("cap_set", { project: { projectRef: ref, maxAgents: n } });
    check(!set.isError, `cap_set ${n}: ${JSON.stringify(set.body)}`);
    const changed = await lab.waitEvent(`agents.cap to ${n}`, 30_000, { cursor: from, types: ["agents.cap"], match: (e) => sameProject(e.data?.projectRef, ref) && e.data?.to === n });
    lab.log(`max agents → ${n}: ${changed.event.summary}`);
    return changed;
  };
  const w = openWorkstream(check, fleetd, "Max agents.");
  const capFrom = await lab.cursor();
  const running = async (ids: ReadonlySet<string>) => (await tasksOf(lab, ref)).filter((t) => ids.has(t.taskId) && t.state === "running").length;
  const until = (what: string, ms: number, cond: () => Promise<boolean>) =>
    lab.until(what, ms, async () => ((await cond()) ? true : (await new Promise((r) => setTimeout(r, 1_000)), undefined)));
  const allComplete = async (ids: ReadonlyArray<string>, from: number, ms: number) => {
    for (const id of ids) {
      const e = await lab.waitEvent(`${id} ends`, ms, { cursor: from, types: TASK_ENDS, match: (e) => e.data?.taskId === id });
      check(e.event.type === "task.completed", `${id} completed, not ${e.event.type}: ${e.event.summary}`);
    }
  };

  // 1. Max 2, six agents: never more than 2 running (sampled every 2 s, and replayed from the events); all six finish.
  await setMax(2);
  let from = await lab.cursor();
  const six = spawnSleepers(lab, fleetd, w, "six-way", 6, 15);
  const sixIds = new Set(six.map((s) => s.taskId));
  const overCap = six.slice(2).filter((s) => !/queued: 2\/2 running/iu.test(s.stdout));
  check(overCap.length === 0, `a spawn beyond the cap says "queued: 2/2 running…": ${JSON.stringify(overCap.map((s) => s.stdout.trim()))}`);
  const reasons = await Promise.all(six.slice(2).map(async (s) => (await taskGet(lab, s.taskId)).queuedReason as string | undefined));
  check(reasons.every((r) => r === "agents: 2/2 running" || r === undefined), `queued for the cap: ${JSON.stringify(reasons)}`);
  let sampled = 0;
  const sampling = (async () => {
    for (let done = false; !done; ) {
      const ts = (await tasksOf(lab, ref)).filter((t) => sixIds.has(t.taskId));
      const slots = ((await lab.callTool("fleetd_status")).body.slots?.perProject as Array<Body> | undefined)?.find((p) => sameProject(p.projectRef, ref));
      sampled = Math.max(sampled, ts.filter((t) => t.state === "running").length, (slots?.running as number | undefined) ?? 0);
      done = ts.every((t) => ["done", "failed", "cancelled"].includes(t.state));
      if (!done) await new Promise((r) => setTimeout(r, 2_000));
    }
  })();
  await allComplete([...sixIds], from, TURN_MS * 4);
  await sampling;
  const replayed = maxConcurrent(await eventsSince(lab, from, RUN_EVENTS), (await tasksOf(lab, ref)).filter((t) => sixIds.has(t.taskId)));
  check(replayed <= 2 && sampled <= 2, `at most 2 ran at once (events: ${replayed}, sampled: ${sampled})`);
  ok(`1. max 2: six agents, at most ${replayed} at once (sampled ${sampled}); all six finished; "${six[2]!.stdout.trim().split("\n")[0]}"`);

  // 2. 12 → 3 mid-run: the four running keep running; a new spawn waits until fewer than 3 run.
  await setMax(12);
  from = await lab.cursor();
  const four = new Set(spawnSleepers(lab, fleetd, w, "lowered", 4, 45).map((s) => s.taskId));
  await until("four agents running", TURN_MS, async () => (await running(four)) === 4);
  await setMax(3);
  const [late] = spawnSleepers(lab, fleetd, w, "after lowering", 1, 1);
  check((await taskGet(lab, late!.taskId)).state === "queued", "a spawn over the lowered cap waits");
  check((await running(four)) === 4, "lowering the cap stopped no running agent");
  await allComplete([...four, late!.taskId], from, TURN_MS * 2);
  const lowered = await eventsSince(lab, from, ["task.started", ...TASK_ENDS]);
  check(!lowered.some((e) => e.type === "task.cancelled" || e.type === "task.failed"), `nothing was killed: ${JSON.stringify(lowered.filter((e) => e.type !== "task.started").map((e) => e.summary))}`);
  const lateStart = lowered.find((e) => e.type === "task.started" && e.data?.taskId === late!.taskId)!;
  const endedFirst = lowered.filter((e) => e.type === "task.completed" && four.has(e.data?.taskId) && e.seq < lateStart.seq).length;
  check(endedFirst >= 2, `the late spawn started only once fewer than 3 ran (${endedFirst} of the 4 ended first)`);
  ok(`2. 12 → 3 mid-run: all four finished, none killed; ${late!.taskId} waited until ${endedFirst} had ended`);

  // 3. 3 → 12 (still 3 from step 2): the queued agents start at once; one quiet chat line; the lead hears "cap raised".
  const lead = await chat.send(`${QUIET} You're this project's lead for the max agents test.`);
  await chat.reply(lead, "the lead is up");
  const leadThread = await chat.leadThread();
  from = await lab.cursor();
  const six2 = spawnSleepers(lab, fleetd, w, "raised", 6, 30).map((s) => s.taskId);
  await until("three of six running", TURN_MS, async () => (await running(new Set(six2))) === 3);
  const raisedAt = Date.now();
  const raised = await setMax(12);
  for (const id of six2) await lab.waitEvent(`${id} running after the raise`, 15_000, { cursor: from, types: ["task.started"], match: (e) => e.data?.taskId === id });
  ok(`3. 3 → 12: all six running ${((Date.now() - raisedAt) / 1000).toFixed(1)} s after the raise`);
  const woke = await lab.waitEvent("the lead wakes on the raise", 60_000, { cursor: raised.cursor, types: ["lead.woken"], match: (e) => leadThread === undefined || e.threadId === leadThread });
  await chat.reply({ cursor: woke.cursor, seq: (await chat.state()).lastSeq as number }, "the raise wake").catch(() => undefined);
  const wake = userMessages(ref.machineId, leadThread ?? "").filter((t) => /cap raised to 12/iu.test(t)).at(-1);
  check(wake, `the lead's wake says the cap was raised: ${JSON.stringify(userMessages(ref.machineId, leadThread ?? "").at(-1)?.slice(-400))}`);
  ok(`the lead's wake: ${wake!.split("\n").find((l) => /cap raised/iu.test(l))?.trim()}`);
  await allComplete(six2, from, TURN_MS * 2);
  const history = await chat.history();
  const line = history.filter((m) => m.author === "system" && m.text === raised.event.summary);
  check(line.length === 1, `one quiet chat line for the change: ${JSON.stringify(raised.event.summary)}`);
  ok(`the chat's line: ${line[0]!.text}`);
  // Every change of the part, not just the raise: one agents.cap event each, and exactly one chat line per event.
  const changes = (await eventsSince(lab, capFrom, ["agents.cap"])).filter((e) => sameProject(e.data?.projectRef, ref)).map((e) => String(e.summary));
  const lines = history.filter((m) => m.author === "system" && /^Max agents\b/u.test(m.text)).map((m) => m.text);
  check(changes.length === 4 && JSON.stringify(lines) === JSON.stringify(changes), `one chat line per cap change, in order: events ${JSON.stringify(changes)}, chat ${JSON.stringify(lines)}`);
  ok(`${changes.length} cap changes, ${lines.length} chat lines, one each`);
}
