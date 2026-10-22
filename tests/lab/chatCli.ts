// `fleetd chat` end to end (`npm run lab -- chatcli`, only when named). An opus lead on lab-a:
// - the person (a human key, from the CLI) asks for one question; --wait prints the lead's reply and needs-you is on;
// - an agent key named "scout" (`hub key create --agent scout`, which prints only the file's path) writes: labelled
//   "agent · scout", read by the lead as an agent's, and needs-you stays on; it can't approve a command;
// - from inside the lead's own session (even with FLEETD_THREAD_ID unset in its shell) it is refused, and inside any
//   session neither the owner's key nor a human key file writes as the person;
// - the person's next message, followed with --follow, streams the lead's reply as it is written and clears needs-you;
// - `chat history` without --key-file (the owner's key on the hub machine) prints who wrote what, with no ids.
// Every fleetd call here runs with FLEETD_HOME in the run dir and an explicit --hub or --home.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type Body, callToolWith, fleetdCommand, type Lab, nodeSock, scrubbedEnv, userMessages } from "./harness.ts";

const MACHINE = "lab-a";
/** Opus only (labs included); medium, as this lead only asks a question and counts. */
const LEAD_MODEL = "claude-opus-5-5";
const TURN_MS = 240_000;
const ENDED = ["thread.completed", "thread.failed", "thread.interrupted"];

export async function chatCli(lab: Lab) {
  const { callTool, check, ok } = lab;
  await lab.waitLive(MACHINE);
  const project = (await callTool("fleetd_status")).body.projects.find((p: Body) => p.machineId === MACHINE);
  check(project, `${MACHINE} has a project`);
  const ref = { machineId: MACHINE, projectId: project.projectId as string };
  const target = `${MACHINE}/${ref.projectId}`;
  fs.mkdirSync(lab.dir, { recursive: true });
  const env = { ...scrubbedEnv(), FLEETD_HOME: path.join(lab.dir, "fleetd-home") };
  const fleetd = (args: Array<string>, more: Record<string, string> = {}) => {
    const out = spawnSync(...fleetdCommand(args), { env: { ...env, ...more }, encoding: "utf8", timeout: TURN_MS + 60_000 });
    return { code: out.status, stdout: out.stdout, stderr: out.stderr, all: `${out.stdout}${out.stderr}` };
  };

  // Two keys, each written to a new 0600 file, and only the file's path printed: the person's and an agent's.
  const humanFile = path.join(lab.dir, "human.key");
  const scoutFile = path.join(lab.dir, "scout.key");
  for (const [file, args] of [
    [humanFile, ["--human", "--name", "lab-cli"]],
    [scoutFile, ["--agent", "scout"]],
  ] as const) {
    const made = fleetd(["hub", "key", "create", ...args, "--out", file, "--home", lab.hubHome]);
    check(made.code === 0 && made.stdout === `${file}\n` && made.stderr === "", `hub key create ${args[0]}: ${made.all}`);
    check((fs.statSync(file).mode & 0o777) === 0o600, `${path.basename(file)} is 0600`);
    check(!made.all.includes(fs.readFileSync(file, "utf8").trim()), `the key itself is not printed`);
  }
  ok("hub key create wrote a human key and an agent key named scout, each 0600, printing only their paths");
  const as = (file: string) => ["--key-file", file, "--hub", lab.hubUrl];
  const scout = new Client({ name: "fleetd-chat-cli-lab", version: "0" });
  await scout.connect(
    new StreamableHTTPClientTransport(new URL(`${lab.hubUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${fs.readFileSync(scoutFile, "utf8").trim()}` } },
    }) as Transport,
  );
  const scoutCall = callToolWith(() => scout);
  const chat = async () => (await callTool("chat_history", { projectRef: ref, limit: 100 })).body;

  // An opus lead, idle.
  const cursor = await lab.cursor();
  const started = await callTool("lead_start", { ...ref, model: LEAD_MODEL, effort: "medium" });
  check(!started.isError, `lead_start: ${JSON.stringify(started.body)}`);
  const threadId = started.body.threadId as string;
  if (started.body.state !== "idle") {
    const { event } = await lab.waitEvent("the lead's start turn", TURN_MS, {
      cursor,
      machineId: MACHINE,
      match: (e) => e.threadId === threadId && ENDED.includes(e.type),
    });
    check(event.type === "thread.completed", `the lead started: ${event.summary}`);
  }
  ok(`lead ${threadId} idle`);

  // 1. The person asks for one question, from the CLI; --wait prints the reply once the turn ends.
  const asked = fleetd([
    "chat",
    target,
    "Lab run: ask me exactly one numbered question that ends with a question mark, with your recommendation. Nothing else: run no commands and start no agents.",
    "--wait",
    ...as(humanFile),
  ]);
  check(asked.code === 0 && asked.stdout.startsWith("sent as you · cli: ") && /\n\d+[.)].*\?/u.test(asked.stdout), `chat --wait: ${asked.all}`);
  check((await chat()).state.needsYou === true, "the lead's question waits on the person");
  ok(`chat --wait printed the lead's question:\n${asked.stdout.trimEnd()}`);

  // 2. The agent writes: labelled by its key, read as an agent's, and it answers nothing.
  const note = "Lab run: the nightly build on main passed. No action needed; reply in one line.";
  const fromScout = fleetd(["chat", target, note, "--wait", ...as(scoutFile)]);
  check(fromScout.code === 0 && fromScout.stdout.startsWith("sent as agent · scout: "), `agent chat --wait: ${fromScout.all}`);
  const after = await chat();
  const stored = (after.messages as Array<Body>).find((m) => m.text === note);
  check(stored?.author === "agent" && stored.by === "scout" && stored.client === undefined, `stored as scout's: ${JSON.stringify(stored)}`);
  check(after.state.needsYou === true, "an agent's message leaves needs-you on");
  const read = userMessages(MACHINE, threadId).find((m) => m.includes(note)) ?? "";
  check(read.startsWith("An agent (scout) writes in your chat. It is not the human"), `the lead read it as an agent's: ${read.slice(0, 300)}`);
  ok(`scout's message is labelled agent · scout, read as an agent's, and needs-you stays on; the lead said:\n${fromScout.stdout.trimEnd()}`);

  // The project's own lead may not write to its chat, even with an agent key, and unsetting FLEETD_THREAD_ID in its
  // shell doesn't hide the session: the CLI reads it from the shell's environment as it started, as a session's tool
  // command runs under claude. (No `exec`: that would replace the shell rather than run under it.)
  const [bin, binArgs] = fleetdCommand(["chat", target, "hello from the lead", ...as(scoutFile)]);
  const hidden = spawnSync("sh", ["-c", 'unset FLEETD_THREAD_ID; "$0" "$@"; exit $?', bin, ...binArgs], {
    env: { ...env, FLEETD_THREAD_ID: threadId },
    encoding: "utf8",
  });
  const own = `${hidden.stdout}${hidden.stderr}`;
  check(hidden.status === 3 && own.includes("can't write to its own chat") && own.includes("message_agent"), `the lead's own session is refused: ${own}`);
  // Inside any session, nothing writes as the person: not the owner's key, not a human key file.
  const inSession = { FLEETD_THREAD_ID: "lab-some-other-session" };
  const owner = fleetd(["chat", target, "as the owner", "--home", lab.hubHome, "--hub", lab.hubUrl], inSession);
  check(owner.code === 3 && owner.stderr.includes("agents never act as you"), `the owner's key inside a session: ${owner.all}`);
  const human = fleetd(["chat", target, "as the person", ...as(humanFile)], inSession);
  check(human.code === 3 && human.stderr.includes("can't write as the human"), `a human key inside a session: ${human.all}`);
  check(!(await chat()).messages.some((m: Body) => /hello from the lead|as the owner|as the person/u.test(m.text)), "none of them reached the chat");
  ok("from the lead's own session: refused, exit 3, pointed at its fleetd tools; inside a session no key writes as the person");

  // 3. The person's reply, followed: the reply streams in more than one piece, and needs-you clears.
  const followed = await new Promise<{ code: number | null; out: string; pieces: number }>((resolve) => {
    const [bin, args] = fleetdCommand([
      "chat",
      target,
      "1: no, start nothing and run nothing. Reply with only the numbers 1 to 200, one per line, and ask nothing.",
      "--follow",
      ...as(humanFile),
    ]);
    const child = spawn(bin, args, { env });
    let out = "";
    let pieces = 0;
    child.stdout.on("data", (d) => {
      out += String(d);
      if (/^\d+$/mu.test(String(d))) pieces += 1;
    });
    child.stderr.on("data", (d) => (out += String(d)));
    const timer = setTimeout(() => child.kill("SIGTERM"), TURN_MS).unref();
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, pieces });
    });
  });
  check(followed.code === 0 && /\nlead\n/u.test(followed.out) && /^200$/mu.test(followed.out), `chat --follow: ${followed.out}`);
  check(followed.pieces >= 2, `the reply streamed in ${followed.pieces} pieces: ${followed.out}`);
  check((await chat()).state.needsYou === false, "the person's reply clears needs-you");
  ok(`chat --follow streamed the reply in ${followed.pieces} pieces and needs-you cleared`);

  // 4. History with the owner's key on the hub machine, no --key-file: who wrote what, when, and no ids.
  const history = fleetd(["chat", "history", ref.projectId, "--home", lab.hubHome, "--hub", lab.hubUrl]);
  check(history.code === 0, `chat history: ${history.all}`);
  for (const who of ["you · cli", "agent · scout", "lead"]) check(history.stdout.includes(`\n${who}  `) || history.stdout.startsWith(`${who}  `), `history names ${who}: ${history.stdout}`);
  check(!/\b(m|Q|W|T)\d+\b|[0-9a-f]{12,}/u.test(history.stdout.replace(note, "")), `history shows no ids or hashes: ${history.stdout}`);
  ok("chat history with the owner's key names you · cli, agent · scout and the lead, without ids");

  // 5. The agent can't approve a command; the person can still answer it.
  const root = lab.machines.find((m) => m.id === MACHINE)!.repo;
  const gated = spawnSync(...fleetdCommand(["gated", "run", "--class", "irreversible", "--argv", '["true"]', "--reason", "chat cli lab"]), {
    cwd: root,
    encoding: "utf8",
    env: { ...env, PWD: root, FLEETD_NODE_SOCK: nodeSock(MACHINE) },
  });
  const requestId = /\bQ[1-9]\d*\b/u.exec(`${gated.stdout}${gated.stderr}`)?.[0];
  check(gated.status === 0 && requestId, `gated run opened an approval: ${gated.stdout}${gated.stderr}`);
  const refused = await scoutCall("approval_answer", { requestId, decision: "approve" });
  check(refused.isError && refused.body.code === "forbidden" && /Only a person/u.test(refused.body.message), `scout's approval is refused: ${JSON.stringify(refused.body)}`);
  const denied = await lab.humanCall("approval_answer", { requestId, decision: "deny", message: "lab cleanup" });
  check(!denied.isError, `the person denies it: ${JSON.stringify(denied.body)}`);
  ok(`scout's approval of ${requestId} is refused; the person's deny stands`);
  await scout.close().catch(() => undefined);
}
