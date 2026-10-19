// The per-project lead chat, end to end (`npm run lab -- chat`, only when named, so it gets a hub of its own). A person
// talks to a project's lead in plain chat messages and the lead does the work: no questions tool, no cards. Haiku/low
// throughout. Parts, in run order (FLEETD_LAB_CHAT_PARTS=a,b picks some; the default is all):
// - history: orders placed before the chat model show up in that project's chat_history as migrated history.
// - work:    a plain chat message to the lab repo's lead becomes a PR the train merges.
// - terse:   the lead asks in chat as numbered items with a recommendation each; "1 go" is understood and acted on.
// - secret:  a secret is requested as an inline chat item, filled with a human key, and its value is in no chat item,
//            event, transcript or hub file.
// - gated:   a gated command waits for a human Approve; nothing runs before it.
// - build:   bug (a): a research result that offers a build, then "build it", starts build work; the order does not
//            just close.
// - fixes:   bug (b): review-fix work open when a workstream closes is never silently cancelled.
// - areas:   bug (c): a repo with packages/a and packages/b and no `areas` gets inferred areas, and two writers in
//            them run at the same time.
// - cap:     the Max agents cap: cap 2 with six agents never runs more than 2; lowering it kills nothing; raising it
//            starts the queue at once and tells the lead; at cap 1 a gating review still gets the slot.
// - plain:   the lead's chat messages carry no internal ids (W-, T-, P-, M-, R-numbers).
// - tools:   no role's session (lead, writer, reviewer, research) has an `ask` tool, and the hub has no inbox tools.
// The lab repo parts run in this slot's namespace of unlaboredlabs/fleetd-lab (reset before and after); the areas and
// cap parts run on a local repo on lab-b, so they cost no CI.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import sodium from "libsodium-wrappers";
import {
  type Body,
  callToolWith,
  cli,
  fleetdCommand,
  LAB,
  type Lab,
  MODEL,
  nodeHome,
  nodeSock,
  requireGhLogin,
  scrubbedEnv,
  sessionText,
} from "./harness.ts";
import { BASE, checkClone, CLONE, NAMESPACE, prepareCheckout, REPO, removeLabRepoProject, resetNamespace } from "./m7Train.ts";

const LEAD_MACHINE = "lab-a";
const WORK_MACHINE = "lab-b";
const TURN_MS = 240_000;
const CI_MS = 600_000;
const ENDED = ["thread.completed", "thread.failed", "thread.interrupted"];
const STAMP = new Date().toISOString().slice(0, 19).replace(/\D/gu, "");
const DIR = `lab/chat-${STAMP}`;
// No `areas`: the hub infers them (bug (c)).
const POLICY = `defaults:\n  model: ${MODEL}\n  effort: low\n`;
const LOCAL_REPO = path.join(LAB, "repo-chat");
const PARTS = ["history", "work", "terse", "secret", "gated", "build", "fixes", "plain", "tools", "areas", "cap"] as const;
type Part = (typeof PARTS)[number];

/** Tools and events the chat model brings, in one place: H1 (chat), H2 (requests), CAP (max agents). */
const API = {
  chatSend: "chat_send",
  chatHistory: "chat_history",
  secretSubmit: "secret_submit",
  requestAnswer: "request_answer",
  requestsList: "requests_list",
  capSet: "cap_set",
  /** H2 removes these from the hub; none may be listed. */
  goneHubTools: ["asks_list", "inbox_reply", "inbox_undo", "digest_get"],
} as const;
/** An `ask` tool in a session's init list: fleetd's own (lead) or Claude's (AskUserQuestion). The worker's ask_lead stays. */
const ASK_TOOL = /^(mcp__fleetd__ask|mcp__fleetd__ask_withdraw|AskUserQuestion)$/u;
/** Internal ids a lead message must not carry: W-, T-, P-, M- and R-numbers. */
const INTERNAL_ID = /\b[WTPMR]\d+\b/u;

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

/** `fleetd …` from a project's workspace through a machine's node socket, as a person's shell runs it. */
const shellIn = (machineId: string, root: string) => (...args: Array<string>) => {
  const out = spawnSync(...fleetdCommand(args), { cwd: root, encoding: "utf8", env: { ...scrubbedEnv(), PWD: root, FLEETD_NODE_SOCK: nodeSock(machineId) } });
  return { code: out.status, stdout: out.stdout, stderr: out.stderr };
};

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...scrubbedEnv(), GIT_AUTHOR_NAME: "lab", GIT_AUTHOR_EMAIL: "lab@localhost", GIT_COMMITTER_NAME: "lab", GIT_COMMITTER_EMAIL: "lab@localhost" },
  });

/** A fresh local repo with two workspace packages and a policy without `areas`. */
const seedLocalRepo = () => {
  fs.rmSync(LOCAL_REPO, { recursive: true, force: true });
  for (const p of ["a", "b"]) {
    fs.mkdirSync(path.join(LOCAL_REPO, "packages", p), { recursive: true });
    fs.writeFileSync(path.join(LOCAL_REPO, "packages", p, "README.md"), `# package ${p}\n`);
  }
  fs.writeFileSync(path.join(LOCAL_REPO, "package.json"), `${JSON.stringify({ name: "chat-lab", private: true, workspaces: ["packages/*"] }, null, 2)}\n`);
  fs.mkdirSync(path.join(LOCAL_REPO, ".fleetd"), { recursive: true });
  fs.writeFileSync(path.join(LOCAL_REPO, ".fleetd/policy.yaml"), POLICY);
  git(LOCAL_REPO, "init", "-q", "-b", "main");
  git(LOCAL_REPO, "add", ".");
  git(LOCAL_REPO, "commit", "-q", "-m", "chat lab: two workspace packages");
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

/** The node's transcript of a thread (claude's stdout), parsed. */
const transcript = (machineId: string, threadId: string): Array<Body> => {
  const file = path.join(nodeHome(machineId), "transcripts", `${threadId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Body);
};
const initToolsOf = (machineId: string, threadId: string) =>
  (transcript(machineId, threadId).find((m) => m.type === "system" && m.subtype === "init")?.tools as Array<string> | undefined) ?? [];

const filesUnder = (dir: string): Array<[string, string]> =>
  !fs.existsSync(dir)
    ? []
    : fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry): Array<[string, string]> => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return filesUnder(full);
        return entry.isFile() ? [[full, fs.readFileSync(full).toString("latin1")]] : [];
      });

export async function chatLead(lab: Lab) {
  const { callTool, check, ok, log } = lab;
  const parts = wanted();
  const on = (p: Part) => parts.has(p);
  await lab.waitLive(LEAD_MACHINE);
  await lab.waitLive(WORK_MACHINE);

  // What this build serves: a missing tool fails the part that needs it, naming the slice that brings it.
  const hubTools = new Set(await listTools(lab));
  const need = (tool: string, slice: string) => check(hubTools.has(tool), `this build has no ${tool} (${slice} brings it)`);

  // A person's key, as the desktop app pairs one: chat messages, secrets and approvals come from it.
  const humanKey = /fld_[a-z2-7]{20,}/u.exec(cli("hub", "key", "create", "--home", lab.hubHome, "--human", "--name", "chat-lab"))?.[0];
  check(humanKey, "hub key create --human printed a key");
  const adminKey = /fld_[a-z2-7]{20,}/u.exec(cli("hub", "key", "create", "--home", lab.hubHome, "--name", "chat-admin", "--role", "admin", "--machines", "*"))?.[0];
  check(adminKey, "hub key create --role admin printed a key");
  const human = await mcpWith(lab.hubUrl, humanKey!);
  const admin = await mcpWith(lab.hubUrl, adminKey!);

  const labRepoParts = (["history", "work", "terse", "secret", "gated", "build", "fixes", "plain", "tools"] as const).filter(on);
  const leadThreads = new Set<string>();
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

  try {
    if (labRepoParts.length > 0) {
      requireGhLogin();
      check(NAMESPACE.startsWith("slot/"), `chat needs CI: run it in a slot/<n> namespace, not ${NAMESPACE}`);
      checkClone(check);
      resetNamespace();
      prepareCheckout(POLICY);
      ok(`${CLONE} at origin/${BASE}; untracked policy without areas; ${NAMESPACE}/ on ${REPO} reset to the seed`);
      const thaw = await callTool("train_freeze", { repo: REPO, frozen: false });
      log(`train_freeze false: ${thaw.isError ? JSON.stringify(thaw.body) : "ok"}`);
      const projectId = await lab.addProject(LEAD_MACHINE, CLONE, "fleetd-lab");
      const ref = { machineId: LEAD_MACHINE, projectId };
      const chat = chatOf(lab, human.callTool, ref, need, leadThreads);

      await part("history", () => historyPart(lab, chat, ref));
      await part("work", () => workPart(lab, chat, ref));
      await part("terse", () => tersePart(lab, chat, ref));
      await part("secret", () => secretPart(lab, chat, ref, human.callTool, need));
      await part("gated", () => gatedPart(lab, chat, ref, human.callTool, need));
      await part("build", () => buildPart(lab, chat, ref));
      await part("fixes", () => fixesPart(lab, chat, ref));
      await part("tools", async () => {
        // Run alone, no part has talked to the lead yet: start it, so its session's tools can be read.
        if ((await chat.leadThread()) === undefined) {
          const from = await lab.cursor();
          const started = await callTool("lead_start", { ...ref, model: MODEL, effort: "low" });
          check(!started.isError, `lead_start: ${JSON.stringify(started.body)}`);
          leadThreads.add(started.body.threadId as string);
          await lab.waitEvent("the lead's start turn", TURN_MS, { cursor: from, machineId: LEAD_MACHINE, match: (e) => e.threadId === started.body.threadId && ENDED.includes(e.type) });
        }
        await toolsPart(lab, hubTools, leadThreads);
      });
      await part("plain", async () => {
        const lead = (await chat.history()).filter((i) => i.role === "lead");
        const leaky = lead.filter((i) => INTERNAL_ID.test(String(i.text)));
        check(leaky.length === 0, `lead messages carry no internal ids: ${JSON.stringify(leaky.map((i) => String(i.text).slice(0, 200)))}`);
        ok(`${lead.length} lead messages, none with an internal id`);
      });
    }
    if (on("areas") || on("cap")) {
      seedLocalRepo();
      const projectId = await lab.addProject(WORK_MACHINE, LOCAL_REPO, "repo-chat");
      const ref = { machineId: WORK_MACHINE, projectId };
      await part("areas", () => areasPart(lab, ref));
      await part("cap", () => capPart(lab, ref, admin.callTool, need));
    }
    check(failures.length === 0, `${failures.length} chat part(s) failed:\n  ${failures.join("\n  ")}`);
  } finally {
    await human.client.close().catch(() => undefined);
    await admin.client.close().catch(() => undefined);
    if (labRepoParts.length > 0) {
      // Only this slot's namespace, never the repo's main.
      resetNamespace();
      await removeLabRepoProject(lab).catch((error: unknown) => log(`could not remove the lab repo project: ${String(error)}`));
      fs.rmSync(path.join(CLONE, ".fleetd"), { recursive: true, force: true });
    }
  }
}

/** The hub's MCP tool names, as an operate key lists them. */
const listTools = async (lab: Lab) => {
  const { client } = await mcpWith(lab.hubUrl, lab.key);
  try {
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close().catch(() => undefined);
  }
};

type ChatItem = Body & { readonly role?: string; readonly kind?: string; readonly text?: string };
type Chat = ReturnType<typeof chatOf>;

/**
 * One project's chat as the person sees it: send a message, read the whole history, and wait for the lead to answer
 * (its turn ends, then the new lead items are read back).
 */
const chatOf = (
  lab: Lab,
  humanCall: Lab["callTool"],
  ref: { machineId: string; projectId: string },
  need: (tool: string, slice: string) => void,
  leadThreads: Set<string>,
) => {
  const history = async (): Promise<Array<ChatItem>> => {
    need(API.chatHistory, "H1, EFF-A");
    const items: Array<ChatItem> = [];
    for (let before: unknown = undefined; ; ) {
      const page = await humanCall(API.chatHistory, { projectRef: ref, limit: 100, ...(before === undefined ? {} : { before }) });
      lab.check(!page.isError, `${API.chatHistory}: ${JSON.stringify(page.body)}`);
      items.unshift(...((page.body.items as Array<ChatItem>) ?? []));
      before = page.body.nextBefore ?? page.body.before;
      if (before === undefined || before === null || (page.body.items as Array<Body>).length === 0) return items;
    }
  };
  const leadThread = async () => {
    const lead = (await lab.callTool("project_get", ref)).body.lead as Body | undefined;
    const threadId = lead?.threadId as string | undefined;
    if (threadId !== undefined) leadThreads.add(threadId);
    return threadId;
  };
  /** Sends `text` as the person; returns the event cursor from just before it. */
  const send = async (text: string) => {
    need(API.chatSend, "H1, EFF-A");
    const cursor = await lab.cursor();
    const sent = await humanCall(API.chatSend, { projectRef: ref, text, clientRequestId: randomUUID() });
    lab.check(!sent.isError, `${API.chatSend}: ${JSON.stringify(sent.body)}`);
    lab.log(`person → lead: ${text.length > 160 ? `${text.slice(0, 160)}…` : text}`);
    return cursor;
  };
  /**
   * Waits for the lead's turns after `cursor` to settle (its thread ends a run and stays idle 15 s, or `until` holds),
   * then returns the lead's chat items that arrived after `known` items.
   */
  const reply = async (cursor: number, what: string, opts: { readonly known?: number; readonly ms?: number } = {}) => {
    const ms = opts.ms ?? TURN_MS;
    const deadline = Date.now() + ms;
    let from = cursor;
    for (;;) {
      const threadId = await leadThread();
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out after ${ms / 1000}s waiting for the lead's reply: ${what}`);
      const ended = await lab
        .waitEvent(`the lead's turn ends: ${what}`, left, { cursor: from, machineId: ref.machineId, match: (e) => (threadId === undefined || e.threadId === threadId) && ENDED.includes(e.type) })
        .catch(() => undefined);
      if (ended === undefined) throw new Error(`timed out after ${ms / 1000}s waiting for the lead's reply: ${what}`);
      lab.check(ended.event.type === "thread.completed", `the lead's turn (${what}) ended with ${ended.event.type}: ${ended.event.summary}`);
      from = ended.cursor;
      // Another wake (a debounced trigger) may follow at once; the reply is in once the lead stays idle.
      const again = await lab
        .waitEvent("the lead starts again", 15_000, { cursor: from, machineId: ref.machineId, types: ["thread.started"], match: (e) => threadId === undefined || e.threadId === threadId })
        .catch(() => undefined);
      if (again === undefined) break;
      from = again.cursor;
    }
    const items = (await history()).slice(opts.known ?? 0).filter((i) => i.role === "lead");
    lab.check(items.length > 0, `the lead answered in chat (${what})`);
    lab.log(`lead → person: ${items.map((i) => String(i.text ?? i.kind)).join(" ¶ ").slice(0, 400)}`);
    return items;
  };
  return { history, send, reply, leadThread };
};

/** The newest workstream of the project, by what the hub lists. */
const workstreams = async (lab: Lab, ref: { machineId: string; projectId: string }) =>
  ((await lab.callTool("workstream_list", { ...ref, limit: 50 })).body.workstreams as Array<Body>) ?? [];

const tasksOf = async (lab: Lab, ref: { machineId: string; projectId: string }) =>
  ((await lab.callTool("tasks_list", { projectRef: ref, limit: 100 })).body.tasks as Array<Body>) ?? [];

// ---- history: the read model of past orders ----
async function historyPart(lab: Lab, chat: Chat, ref: { machineId: string; projectId: string }) {
  // TODO(EFF-A): how a past order is seeded on a fresh hub (old binary, or intake before the chat model).
  const items = await chat.history();
  lab.check(Array.isArray(items), "chat_history pages");
  void ref;
}

// ---- work: a chat message becomes a merged PR ----
async function workPart(lab: Lab, chat: Chat, ref: { machineId: string; projectId: string }) {
  const { check, ok } = lab;
  const file = `${DIR}/hello.md`;
  const known = (await chat.history()).length;
  const from = await chat.send(`Please add ${file} with the single line "hello from chat". One small PR is plenty.`);
  await chat.reply(from, "the hello request", { known });
  const writer = await lab.waitEvent("a writer starts for the hello request", TURN_MS * 2, {
    cursor: from,
    types: ["task.started"],
    match: (e) => e.projectId === ref.projectId || e.machineId === ref.machineId,
  });
  const task = (await lab.callTool("task_get", { taskId: writer.event.data.taskId })).body.task as Body;
  ok(`the lead started ${task.kind} agent "${task.title}"`);
  const merged = await lab.waitEvent(`a PR adding ${file} merges through the train`, CI_MS + TURN_MS * 3, {
    cursor: from,
    types: ["pr.merged"],
    match: (e) => e.data?.repo === REPO,
  });
  check(merged.event.data.prNumber, `pr.merged names its PR: ${JSON.stringify(merged.event.data)}`);
  ok(`chat message → ${task.kind} agent → PR #${merged.event.data.prNumber} merged by the train`);
}

// ---- terse: numbered questions with a rec; "1 go" ----
async function tersePart(lab: Lab, chat: Chat, ref: { machineId: string; projectId: string }) {
  const { check, ok } = lab;
  const file = `${DIR}/digest.md`;
  const known = (await chat.history()).length;
  const from = await chat.send(
    `Next, add ${file}: one line saying which day the weekly usage digest email goes out. I haven't picked the day yet and it's my call, so ask me before you build it.`,
  );
  const said = await chat.reply(from, "the digest question", { known });
  const asking = said.find((i) => /^\s*1[.)]\s/mu.test(String(i.text)));
  check(asking, `the lead asks as numbered items: ${JSON.stringify(said.map((i) => i.text))}`);
  check(/\b(rec|recommend)/iu.test(String(asking!.text)), `each question has a recommendation: ${asking!.text}`);
  const needsYou = await needsYouOf(lab, ref);
  check(needsYou === true, `the project shows needs-you while the lead waits: ${needsYou}`);
  ok(`numbered question with a rec; needs-you on`);

  const knownAfter = (await chat.history()).length;
  const replyFrom = await chat.send("1 go");
  await chat.reply(replyFrom, "the terse answer", { known: knownAfter });
  const decided = (await lab.callTool("decisions_search", { query: "digest" })).body.decisions as Array<Body> | undefined;
  check((decided ?? []).length > 0, `the lead logged the answer with decide: ${JSON.stringify(decided)}`);
  const writer = await lab.waitEvent(`a writer starts for ${file} after "1 go"`, TURN_MS * 2, {
    cursor: replyFrom,
    types: ["task.started"],
    match: (e) => e.machineId === ref.machineId,
  });
  check((await needsYouOf(lab, ref)) !== true, "needs-you clears once the person answered");
  ok(`"1 go" → decision ${decided![0]!.key} = ${decided![0]!.value}; agent ${writer.event.data.taskId} started`);
}

/** The project's needs-you state: the lead waits on a person's reply. TODO(EFF-A): the field's home. */
const needsYouOf = async (lab: Lab, ref: { machineId: string; projectId: string }) => {
  const project = (await lab.callTool("project_get", ref)).body;
  return (project.needsYou ?? project.chat?.needsYou ?? project.project?.needsYou) as boolean | undefined;
};

// ---- secret: an inline secret item; the value is in no chat item ----
async function secretPart(lab: Lab, chat: Chat, ref: { machineId: string; projectId: string }, humanCall: Lab["callTool"], need: (t: string, s: string) => void) {
  const { check, ok } = lab;
  need(API.secretSubmit, "H2, NS");
  const value = `lab-chat-secret-${createHash("sha256").update(randomUUID()).digest("hex").slice(0, 24)}`;
  const sink = path.join(lab.dir, "secret.env");
  fs.mkdirSync(lab.dir, { recursive: true });
  fs.writeFileSync(sink, "OTHER=1\n");
  const known = (await chat.history()).length;
  const from = await chat.send(
    `For a later step I need the lab API key. Request it from me as a secret (request_secret, key lab.api_key, sink env:${ref.machineId}:${sink}, envName LAB_API_KEY). Don't ask me to paste it here.`,
  );
  const opened = await lab.waitEvent("request.opened for the secret", TURN_MS, { cursor: from, types: ["request.opened"], match: (e) => e.data?.kind === "secret" });
  const request = opened.event.data as Body;
  check(request.key === "lab.api_key" && request.state === "open", `the secret request: ${JSON.stringify(request)}`);
  await chat.reply(from, "the secret request", { known });
  const item = (await chat.history()).find((i) => JSON.stringify(i).includes(request.requestId as string));
  check(item, `the chat shows the secret request inline (${request.requestId})`);
  ok(`inline secret item ${JSON.stringify({ kind: item!.kind, role: item!.role })}`);

  const machine = ((await lab.callTool("fleetd_status")).body.machines as Array<Body>).find((m) => m.machineId === ref.machineId);
  check(typeof machine?.boxPubKey === "string", `${ref.machineId} has a box key`);
  await sodium.ready;
  const sealed = sodium.to_base64(
    sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(machine!.boxPubKey, sodium.base64_variants.ORIGINAL)),
    sodium.base64_variants.ORIGINAL,
  );
  const refused = await lab.callTool(API.secretSubmit, { requestId: request.requestId, sealed });
  check(refused.isError, `an agent key cannot fill a secret: ${JSON.stringify(refused.body)}`);
  const cursor = await lab.cursor();
  const saved = await humanCall(API.secretSubmit, { requestId: request.requestId, sealed });
  check(!saved.isError, `${API.secretSubmit}: ${JSON.stringify(saved.body)}`);
  await lab.waitEvent("request.updated stored", 60_000, { cursor, types: ["request.updated"], match: (e) => e.data?.requestId === request.requestId && e.data?.state === "stored" });
  check(fs.readFileSync(sink, "utf8").includes(`LAB_API_KEY=${value}`), "the sink holds the value");
  // The lead hears the outcome in a wake; let it settle before searching.
  await chat.reply(cursor, "the secret stored wake", { known: (await chat.history()).length }).catch(() => undefined);

  const hist = JSON.stringify(await chat.history());
  check(!hist.includes(value) && !hist.includes(sealed), "the value is in no chat item");
  const events = JSON.stringify(await eventsSince(lab, 0));
  check(!events.includes(value) && !events.includes(sealed), "the value is in no event");
  const threadId = await chat.leadThread();
  const session = threadId === undefined ? "" : sessionText(ref.machineId, threadId);
  check(!session.includes(value), "the value is in no lead transcript");
  const hits = filesUnder(lab.hubHome).filter(([, text]) => text.includes(value) || text.includes(sealed)).map(([f]) => f);
  check(hits.length === 0, `the value is in no hub file: ${hits.join(", ")}`);
  ok("secret stored through the inline item; the value is in no chat item, event, lead transcript or hub file");
}

// ---- gated: nothing runs before Approve ----
async function gatedPart(lab: Lab, chat: Chat, ref: { machineId: string; projectId: string }, humanCall: Lab["callTool"], need: (t: string, s: string) => void) {
  const { check, ok } = lab;
  need(API.requestAnswer, "H2, NS");
  const marker = path.join(lab.dir, "gated.txt");
  fs.mkdirSync(lab.dir, { recursive: true });
  fs.rmSync(marker, { force: true });
  const argv = ["sh", "-c", `echo gated > ${marker}`];
  const known = (await chat.history()).length;
  const from = await chat.send(
    `Run this exact command as a gated command (gated_run, class irreversible, reason "chat lab"): ${JSON.stringify(argv)}. Wait for my approval; don't run it any other way.`,
  );
  const opened = await lab.waitEvent("request.opened for the gated command", TURN_MS, { cursor: from, types: ["request.opened"], match: (e) => e.data?.kind === "approval" });
  const request = opened.event.data as Body;
  check(JSON.stringify(request.gated?.argv) === JSON.stringify(argv), `the request shows the exact command: ${JSON.stringify(request.gated)}`);
  await chat.reply(from, "the gated request", { known });
  const item = (await chat.history()).find((i) => JSON.stringify(i).includes(request.requestId as string));
  check(item, `the chat shows the gated command inline (${request.requestId})`);

  // Held: nothing ran while nobody approved, and an agent key cannot approve.
  await new Promise((r) => setTimeout(r, 10_000));
  check(!fs.existsSync(marker), "the command did not run before Approve");
  const early = (await eventsSince(lab, opened.cursor, ["request.updated"])).filter((e) => e.data?.requestId === request.requestId);
  check(early.every((e) => e.data?.state === "open"), `no state change before Approve: ${JSON.stringify(early.map((e) => e.data?.state))}`);
  const byAgent = await lab.callTool(API.requestAnswer, { requestId: request.requestId, decision: "approve" });
  check(byAgent.isError, `an agent key cannot approve: ${JSON.stringify(byAgent.body)}`);
  check(!fs.existsSync(marker), "still not run after the agent key's try");

  const cursor = await lab.cursor();
  const approved = await humanCall(API.requestAnswer, { requestId: request.requestId, decision: "approve" });
  check(!approved.isError, `${API.requestAnswer} approve: ${JSON.stringify(approved.body)}`);
  const done = await lab.waitEvent("the approved command finishes", 60_000, {
    cursor,
    types: ["request.updated"],
    match: (e) => e.data?.requestId === request.requestId && ["done", "failed"].includes(e.data?.state),
  });
  check(done.event.data.state === "done" && fs.readFileSync(marker, "utf8") === "gated\n", `ran once approved: ${JSON.stringify(done.event.data)}`);
  ok(`gated command held until Approve (${request.requestId}), then ran: ${done.event.data.evidence ?? "exit 0"}`);
  await chat.reply(cursor, "the gated result wake", { known: (await chat.history()).length }).catch(() => undefined);
}

// ---- build: bug (a), a research result that offers a build, then "build it" ----
async function buildPart(lab: Lab, chat: Chat, ref: { machineId: string; projectId: string }) {
  const { check, ok } = lab;
  const file = `${DIR}/faq.md`;
  const known = (await chat.history()).length;
  const from = await chat.send(
    `Research first: would a short FAQ page at ${file} help this repo? Have one read-only research agent look and report back to me with a recommendation. Don't build anything until I say.`,
  );
  const research = await lab.waitEvent("a research agent starts", TURN_MS * 2, { cursor: from, types: ["task.started"], match: (e) => e.machineId === ref.machineId });
  const researchTask = (await lab.callTool("task_get", { taskId: research.event.data.taskId })).body.task as Body;
  check(researchTask.kind !== "write", `the first agent only researches: ${researchTask.kind}`);
  await lab.waitEvent("the research agent ends", TURN_MS * 2, { cursor: research.cursor, types: ["task.completed", "task.failed"], match: (e) => e.data?.taskId === researchTask.taskId });
  const offer = await chat.reply(research.cursor, "the research result", { known, ms: TURN_MS * 2 });
  check(offer.some((i) => /\bbuild\b/iu.test(String(i.text))), `the lead offers the build: ${JSON.stringify(offer.map((i) => i.text))}`);
  const workstreamId = researchTask.workstreamId as string | undefined;

  const knownAfter = (await chat.history()).length;
  const replyFrom = await chat.send("build it");
  const writer = await lab.waitEvent(`a writer starts for ${file} after "build it"`, TURN_MS * 2, {
    cursor: replyFrom,
    types: ["task.started"],
    match: (e) => e.machineId === ref.machineId,
  });
  const writerTask = (await lab.callTool("task_get", { taskId: writer.event.data.taskId })).body.task as Body;
  check(writerTask.kind === "write", `"build it" starts build work: ${writerTask.kind} "${writerTask.title}"`);
  await chat.reply(replyFrom, "the build answer", { known: knownAfter });
  // The research workstream did not swallow the answer by closing without build work.
  const done = (await eventsSince(lab, from, ["workstream.done"])).filter((e) => e.data?.workstreamId === workstreamId && e.seq < writer.event.seq);
  check(done.length === 0 || writerTask.workstreamId !== workstreamId, `${workstreamId} closed before the build started, and the build is not a follow-up: ${JSON.stringify(done)}`);
  ok(`research ${researchTask.taskId} → offer → "build it" → writer ${writerTask.taskId} (${writerTask.title})`);
}

// ---- fixes: bug (b), review-fix work survives a workstream closing ----
async function fixesPart(lab: Lab, chat: Chat, ref: { machineId: string; projectId: string }) {
  // TODO(EFF-B): the W1/T4 reproduction.
  void chat;
  void ref;
  lab.check(false, "the review-fix reproduction is not written yet (H4, EFF-B)");
}

// ---- areas: bug (c), inferred areas let two writers run at once ----
async function areasPart(lab: Lab, ref: { machineId: string; projectId: string }) {
  const { check, ok } = lab;
  const inspected = await lab.callTool("project_inspect", { machineId: ref.machineId, path: LOCAL_REPO });
  check(!inspected.isError, `project_inspect: ${JSON.stringify(inspected.body)}`);
  const inspect = (inspected.body.inspect ?? inspected.body) as Body;
  const areas = (inspect?.areas as Array<string> | undefined) ?? [];
  check(inspect?.areasInferred === true && ["a", "b", "all"].every((a) => areas.includes(a)), `areas inferred from the workspace: ${JSON.stringify(inspect)}`);
  ok(`inferred areas: ${areas.join(", ")}`);

  const fleetd = shellIn(ref.machineId, LOCAL_REPO);
  const intake = await lab.callTool("intake_submit", { ...ref, text: "chat lab: two packages at once (the harness spawns the writers)", clientRequestId: randomUUID() });
  check(!intake.isError, `intake_submit: ${JSON.stringify(intake.body)}`);
  const w = intake.body.workstreamId as string;
  const from = await lab.cursor();
  const spawn = (area: string) => {
    const out = fleetd(
      "task", "spawn", "--workstream", w, "--title", `note in ${area}`, "--areas", area, "--model", MODEL, "--effort", "low",
      "--prompt", `Append the line "chat lab" to packages/${area}/README.md and commit it with the message "chat lab: ${area}". Reply with the commit hash.`,
    );
    const taskId = /^Spawned (T\d+)/mu.exec(out.stdout)?.[1];
    check(out.code === 0 && taskId, `task spawn --areas ${area}: ${JSON.stringify(out)}`);
    return taskId!;
  };
  const ta = spawn("a");
  const tb = spawn("b");
  const ends = new Map<string, Body>();
  for (const t of [ta, tb]) {
    const e = await lab.waitEvent(`${t} ends`, TURN_MS, { cursor: from, types: ["task.completed", "task.failed"], match: (e) => e.data?.taskId === t });
    ends.set(t, e.event);
  }
  const seen = await eventsSince(lab, from, ["task.queued", "task.started", "task.completed", "task.failed"]);
  const start = (t: string) => seen.find((e) => e.type === "task.started" && e.data?.taskId === t);
  const leaseWaits = seen.filter((e) => e.type === "task.queued" && /lease/u.test(String(e.data?.queuedReason)));
  check(leaseWaits.length === 0, `no writer waited on an area lease: ${JSON.stringify(leaseWaits.map((e) => e.summary))}`);
  const [sa, sb] = [start(ta), start(tb)];
  check(sa && sb, `both writers started: ${JSON.stringify(seen.map((e) => e.summary))}`);
  const firstEnd = Math.min(ends.get(ta)!.seq as number, ends.get(tb)!.seq as number);
  check((sa!.seq as number) < firstEnd && (sb!.seq as number) < firstEnd, `both started before either ended (starts ${sa!.seq}, ${sb!.seq}; first end ${firstEnd})`);
  ok(`${ta} (area a) and ${tb} (area b) ran at the same time`);
}

// ---- cap: the Max agents cap ----
async function capPart(lab: Lab, ref: { machineId: string; projectId: string }, adminCall: Lab["callTool"], need: (t: string, s: string) => void) {
  // TODO(CAP): the per-project cap tool and the queued result; written once feat/max-agents is up.
  void ref;
  void adminCall;
  need(API.capSet, "CAP");
  lab.check(false, "the cap part is not written yet (CAP)");
}

// ---- tools: no `ask` anywhere ----
async function toolsPart(lab: Lab, hubTools: ReadonlySet<string>, leadThreads: ReadonlySet<string>) {
  const { check, ok } = lab;
  const gone = API.goneHubTools.filter((t) => hubTools.has(t));
  check(gone.length === 0, `the hub lists no inbox or ask tools: ${gone.join(", ")}`);
  const sessions: Array<{ what: string; machineId: string; threadId: string }> = [...leadThreads].map((threadId) => ({ what: "lead", machineId: LEAD_MACHINE, threadId }));
  for (const machineId of [LEAD_MACHINE, WORK_MACHINE]) {
    const projects = ((await lab.callTool("projects_list", { machineId })).body.projects as Array<Body>) ?? [];
    for (const p of projects) {
      for (const t of await tasksOf(lab, { machineId, projectId: p.projectId as string })) {
        if (t.threadRef?.threadId) sessions.push({ what: `${t.kind} agent`, machineId, threadId: t.threadRef.threadId as string });
      }
    }
  }
  const withInit = sessions.map((s) => ({ ...s, tools: initToolsOf(s.machineId, s.threadId) })).filter((s) => s.tools.length > 0);
  check(withInit.some((s) => s.what === "lead"), `a lead session's tools were read: ${JSON.stringify(sessions.map((s) => s.what))}`);
  const asking = withInit.filter((s) => s.tools.some((t) => ASK_TOOL.test(t)));
  check(asking.length === 0, `no session has an ask tool: ${JSON.stringify(asking.map((s) => [s.what, s.tools.filter((t) => ASK_TOOL.test(t))]))}`);
  const roles = [...new Set(withInit.map((s) => s.what))];
  ok(`${withInit.length} sessions (${roles.join(", ")}): no ask tool in any; the hub has none of ${API.goneHubTools.join(", ")}`);
}
