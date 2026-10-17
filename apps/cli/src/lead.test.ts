import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Decision, LeadCallFrame, LeadResultFrame, Task } from "@fleetd/contracts";
import { serveLeadSocket } from "@fleetd/node/LeadCalls.ts";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import { afterAll, describe, expect, it } from "vitest";
import { callerCwd, formatResult, leadCommand, nodeSocketPath, parseLeadArgs } from "./lead.ts";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-cli-")));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const brief = {
  goal: "add /healthz",
  why: "probes",
  pointers: [],
  constraints: [],
  doneWhen: [{ type: "http", url: "http://127.0.0.1:8080/healthz", status: 200 }],
  tier: "S",
};

const decision: Decision = {
  decisionId: "D3" as Decision["decisionId"],
  key: "api.health.path" as Decision["key"],
  scope: { kind: "project", projectRef: { machineId: "lab-a" as never, projectId: "p" as never } },
  value: "/healthz",
  source: "human",
  state: "active",
  at: "2026-10-17T10:00:00.000Z",
};

describe("parseLeadArgs", () => {
  it("builds each call the spec lists", () => {
    expect(parseLeadArgs(["brief", "create", "--workstream", "W12", "--json", JSON.stringify(brief)])).toEqual({
      op: "brief_create",
      workstreamId: "W12",
      brief,
    });
    expect(
      parseLeadArgs(["brief", "create", "--workstream", "W12", "--file", "b.json", "--amend", "A4"], () => JSON.stringify(brief)),
    ).toMatchObject({ op: "brief_create", amend: "A4" });
    expect(
      parseLeadArgs([
        "ask", "--key", "api.health.path", "--class", "product", "--text", "Path?", "--rec", "/healthz",
        "--options", "/healthz, /health", "--blocks", "deploy", "--proceeded", "--workstream", "W12",
      ]),
    ).toEqual({
      op: "ask",
      kind: "decide",
      key: "api.health.path",
      class: "product",
      text: "Path?",
      recommendation: "/healthz",
      options: ["/healthz", "/health"],
      blocks: "deploy",
      proceededOnRec: true,
      workstreamId: "W12",
    });
    expect(parseLeadArgs(["ask", "withdraw", "A7", "--use", "D3"])).toEqual({ op: "ask_withdraw", askId: "A7", use: "D3" });
    expect(parseLeadArgs(["decide", "--key", "api.style", "--value", "rest", "--why", "simpler", "--scope", "project"])).toEqual({
      op: "decide",
      key: "api.style",
      value: "rest",
      why: "simpler",
      scope: "project",
    });
    expect(parseLeadArgs(["status", "set", "health", "endpoint", "half", "done", "--workstream", "W12"])).toEqual({
      op: "status_set",
      text: "health endpoint half done",
      workstreamId: "W12",
    });
    expect(parseLeadArgs(["decisions", "search", "health path"])).toEqual({ op: "decisions_search", query: "health path" });
  });

  it("fills the contract's defaults: a decide ask, blocking nothing, decided at workstream scope", () => {
    expect(parseLeadArgs(["ask", "--key", "a.b", "--class", "money", "--text", "Pay?", "--rec", "no"])).toMatchObject({
      kind: "decide",
      blocks: "nothing",
      proceededOnRec: false,
    });
    expect(parseLeadArgs(["decide", "--key", "a.b", "--value", "v"])).toMatchObject({ scope: "workstream" });
  });

  it("takes a do ask's steps from repeated --step flags", () => {
    const step1 = { text: "Create the DNS record", where: "browser" };
    const step2 = { text: "Reload", where: "lab-a", command: "systemctl --user reload caddy", expect: "no output" };
    expect(
      parseLeadArgs([
        "ask", "--kind", "do", "--key", "dns.health", "--class", "irreversible", "--text", "Add DNS",
        "--step", JSON.stringify(step1), "--step", JSON.stringify(step2),
      ]),
    ).toMatchObject({ op: "ask", kind: "do", steps: [step1, step2] });
  });

  it("leaves the class to the hub, which refuses the ones outside the four with its fix text", () => {
    expect(parseLeadArgs(["ask", "--key", "ui.name", "--class", "naming", "--text", "Name?", "--rec", "Fleet"])).toMatchObject({
      class: "naming",
    });
  });

  it("explains usage errors in one line", () => {
    const cases: Array<[ReadonlyArray<string>, string | RegExp]> = [
      [["ask", "--class", "product", "--text", "t", "--rec", "r"], "--key is required"],
      [["ask", "--key", "API.Path", "--class", "product", "--text", "t", "--rec", "r"], /^invalid input: .*\^\[a-z0-9\]\+.* at \["key"\]$/u],
      [["ask", "--key", "a.b", "--class", "product", "--text", "t"], /a decide ask needs a recommendation/u],
      [["ask", "--kind", "do", "--key", "a.b", "--class", "product", "--text", "t"], /a do ask needs at least one step/u],
      [
        ["ask", "--kind", "do", "--key", "a.b", "--class", "product", "--text", "t", "--step", '{"text":"x","where":"phone","command":"login <token>"}'],
        /no <placeholders>.* at \["steps"\]\[0\]\["command"\]$/u,
      ],
      [["ask", "--kind", "do", "--key", "a.b", "--class", "product", "--text", "t", "--step", "{text"], /^--step 1 is not valid JSON/u],
      [["ask", "--key", "a.b", "--value", "v"], "--value does not apply to fleetd ask"],
      [["ask", "--bogus"], /Unknown option '--bogus'/u],
      [["brief", "create", "--workstream", "W1"], "give the brief with exactly one of --json and --file"],
      [["brief", "create", "--workstream", "W1", "--json", "{"], /^--json is not valid JSON/u],
      [["brief", "create", "--workstream", "W1", "--json", JSON.stringify({ ...brief, doneWhen: [] })], /at \["brief"\]\["doneWhen"\]$/u],
      [["brief", "create", "--workstream", "12", "--json", JSON.stringify(brief)], /at \["workstreamId"\]$/u],
      [["brief", "create", "--workstream", "W1", "--file", "missing.json"], "cannot read --file missing.json"],
      [["decide", "--key", "a.b"], "--value is required"],
      [["decide", "--key", "a.b", "--value", "v", "--scope", "global"], /at \["scope"\]$/u],
      [["status", "set"], 'expected fleetd status set "<one line>"'],
      [["status", "show"], 'expected fleetd status set "<one line>"'],
      [["decisions", "search"], 'expected fleetd decisions search "<query>"'],
      [["decisions", "search", "x", "--workstream", "W1"], "--workstream does not apply to fleetd decisions search"],
    ];
    for (const [argv, expected] of cases) {
      const result = parseLeadArgs(argv, () => {
        throw new Error("no such file");
      });
      expect(typeof result, argv.join(" ")).toBe("string");
      if (typeof expected === "string") expect(result).toBe(expected);
      else expect(result).toMatch(expected);
    }
  });
});

describe("callerCwd", () => {
  const real = path.join(dir, "real-project");
  const link = path.join(dir, "linked-project");
  fs.mkdirSync(path.join(real, "src"), { recursive: true });
  fs.symlinkSync(real, link);

  it("keeps the shell's logical path through a symlink, since T3 keeps workspace roots as written", () => {
    expect(callerCwd({ PWD: path.join(link, "src") }, path.join(real, "src"))).toBe(path.join(link, "src"));
    expect(callerCwd({ PWD: `${link}/./src/` }, path.join(real, "src"))).toBe(`${path.join(link, "src")}/`);
  });

  it("falls back to the resolved path when PWD is missing, relative, stale or gone", () => {
    expect(callerCwd({}, real)).toBe(real);
    expect(callerCwd({ PWD: "linked-project" }, real)).toBe(real);
    expect(callerCwd({ PWD: link }, path.join(real, "src"))).toBe(path.join(real, "src"));
    expect(callerCwd({ PWD: path.join(dir, "deleted") }, real)).toBe(real);
  });
});

describe("nodeSocketPath", () => {
  it("prefers FLEETD_NODE_SOCK, else the default node home", () => {
    expect(nodeSocketPath({ FLEETD_NODE_SOCK: "/run/x.sock" })).toBe("/run/x.sock");
    expect(nodeSocketPath({ FLEETD_NODE_SOCK: "" })).toBe(path.join(os.homedir(), ".fleetd/node/node.sock"));
  });
});

describe("task commands", () => {
  const task = (over: Partial<Task> = {}): Task =>
    ({
      taskId: "T1",
      projectRef: { machineId: "lab-a", projectId: "p" },
      workstreamId: "W1",
      title: "add file",
      kind: "write",
      prompt: "create docs/x.md",
      areas: ["docs"],
      model: "claude-haiku-5-5",
      effort: "low",
      state: "running",
      attempt: 1,
      branch: "fleetd/T1-add-file",
      createdAt: "2026-10-17T10:00:00.000Z",
      ...over,
    }) as Task;

  it("parses spawn, list, status, message and cancel", () => {
    expect(
      parseLeadArgs([
        "task", "spawn", "--workstream", "W1", "--title", "add file", "--areas", "docs, api", "--prompt", "create docs/x.md",
        "--model", "claude-haiku-5-5", "--effort", "low", "--estimate", "5", "--serves", "done 1",
      ]),
    ).toEqual({
      op: "task_spawn",
      workstreamId: "W1",
      title: "add file",
      kind: "write",
      prompt: "create docs/x.md",
      areas: ["docs", "api"],
      model: "claude-haiku-5-5",
      effort: "low",
      estimateMinutes: 5,
      serves: "done 1",
    });
    expect(parseLeadArgs(["task", "spawn", "--workstream", "W1", "--title", "look", "--kind", "read", "--prompt", "read README"])).toMatchObject({
      kind: "read",
      areas: [],
    });
    expect(parseLeadArgs(["task", "list", "--state", "queued"])).toEqual({ op: "task_list", state: "queued" });
    expect(parseLeadArgs(["task", "status", "T3"])).toEqual({ op: "task_status", taskId: "T3" });
    expect(parseLeadArgs(["task", "message", "T3", "use", "y.md"])).toEqual({ op: "task_message", taskId: "T3", message: "use y.md" });
    expect(parseLeadArgs(["task", "cancel", "T3", "--reason", "dup"])).toEqual({ op: "task_cancel", taskId: "T3", reason: "dup" });
  });

  it("refuses incomplete or malformed task calls with a usage line", () => {
    expect(parseLeadArgs(["task", "spawn", "--workstream", "W1", "--title", "x", "--prompt", "y"])).toMatch(/at least one area/u);
    expect(parseLeadArgs(["task", "spawn", "--title", "x", "--prompt", "y"])).toBe("--workstream is required");
    expect(parseLeadArgs(["task", "spawn", "--workstream", "W1", "--title", "x", "--prompt", "y", "--areas", "docs", "--effort", "huge"])).toMatch(/^invalid input/u);
    expect(parseLeadArgs(["task", "status", "X1"])).toMatch(/^invalid input/u);
    expect(parseLeadArgs(["task", "status"])).toBe("expected fleetd task status <T>");
    expect(parseLeadArgs(["task", "message", "T1"])).toBe('expected fleetd task message <T> "<text>"');
    expect(parseLeadArgs(["task", "list", "--reason", "x"])).toBe("--reason does not apply to fleetd task list");
    expect(parseLeadArgs(["task", "run"])).toBe("expected fleetd task spawn|list|status|message|cancel");
  });

  it("says what happened to the task and what the lead does next", () => {
    expect(formatResult({ op: "task_spawn", task: task() })).toBe(
      [
        "Spawned T1: running.",
        "T1 running [write, docs, claude-haiku-5-5/low] add file on fleetd/T1-add-file",
        "Next: don't poll it. T1's result arrives inline in a later wake; end your turn when you have nothing else to do.",
        "",
      ].join("\n"),
    );
    const queued = task({ taskId: "T2" as Task["taskId"], state: "queued", queuedReason: "lease: docs held by T1" });
    expect(formatResult({ op: "task_spawn", task: queued })).toContain("Spawned T2: queued (lease: docs held by T1).");
    expect(formatResult({ op: "task_spawn", task: queued })).toContain("Next: nothing to do; T2 starts by itself once that clears");
    const done = task({
      state: "done",
      threadRef: { machineId: "lab-a", threadId: "t9" } as Task["threadRef"],
      result: { status: "done", tail: "Created docs/x.md.\nCommitted.", branch: "fleetd/T1-add-file", at: "2026-10-17T10:05:00.000Z" },
    });
    expect(formatResult({ op: "task_status", task: done })).toBe(
      [
        "T1 done [write, docs, claude-haiku-5-5/low] add file on fleetd/T1-add-file",
        "  workstream W1, attempt 1",
        "  thread lab-a/t9",
        "  result (done):",
        "  > Created docs/x.md.",
        "  > Committed.",
        'Next: judge the result. fleetd task message T1 "<text>" continues the same thread; or spawn a follow-up task.',
        "",
      ].join("\n"),
    );
    expect(formatResult({ op: "task_status", task: task({ state: "idle" }) })).toContain('answer it with fleetd task message T1 "<answer>"');
    expect(formatResult({ op: "task_list", tasks: [] })).toBe("No tasks.\nNext: spawn work with fleetd task spawn.\n");
  });
});

describe("formatResult", () => {
  it("states what happened and the next step", () => {
    expect(formatResult({ op: "ask", state: "auto", askId: "A2" as never, decision })).toBe(
      "Already decided, so not asked: D3 api.health.path = /healthz (project, by human).\nNext: use this answer and do not ask again.\n",
    );
    expect(formatResult({ op: "ask", state: "open", askId: "A7" as never, candidates: [decision] })).toBe(
      [
        "Filed A7. It goes to the human in the next batch.",
        "Decisions that may already answer it:",
        "  D3 api.health.path = /healthz (project, by human)",
        "Next: if one of these answers it, run fleetd ask withdraw A7 --use <D>; otherwise carry on without waiting. The answer arrives in a later wake.",
        "",
      ].join("\n"),
    );
    expect(formatResult({ op: "status_set", workstreamId: "W1" as never, next: "wait for the reviewers" })).toBe(
      "Status set for W1.\nNext: wait for the reviewers\n",
    );
  });
});

describe("leadCommand", () => {
  const ask = ["ask", "--key", "api.health.path", "--class", "product", "--text", "Path?", "--rec", "/healthz"];
  const answering = (answer: Omit<LeadResultFrame, "t" | "id"> | { readonly unreachable: string }) => {
    const sent: Array<{ socketPath: string; frame: LeadCallFrame }> = [];
    const send = async (socketPath: string, frame: LeadCallFrame) => {
      sent.push({ socketPath, frame });
      return "unreachable" in answer ? answer : ({ t: "lead_result", id: frame.id, ...answer } as LeadResultFrame);
    };
    return { sent, send };
  };

  it("exits 0 with the result, sending the caller's cwd to the socket FLEETD_NODE_SOCK names", async () => {
    const node = answering({ result: { op: "ask", state: "open", askId: "A1" as never } });
    const result = await leadCommand(ask, { env: { FLEETD_NODE_SOCK: "/tmp/n.sock" }, cwd: "/src/api", send: node.send });
    expect(result).toEqual({
      code: 0,
      stdout: "Filed A1. It goes to the human in the next batch.\nNext: carry on without waiting; the answer arrives in a later wake.\n",
      stderr: "",
    });
    expect(node.sent).toMatchObject([{ socketPath: "/tmp/n.sock", frame: { t: "lead_call", cwd: "/src/api", call: { op: "ask" } } }]);
  });

  it("exits 3 with the refusal text and its fix", async () => {
    const node = answering({
      error: { code: "invalid", message: "naming is not a class you ask about", fix: "decide this yourself and log it with `fleetd decide`" },
    });
    expect(await leadCommand(ask, { env: {}, cwd: "/src/api", send: node.send })).toEqual({
      code: 3,
      stdout: "",
      stderr: "Refused: naming is not a class you ask about\nNext: decide this yourself and log it with `fleetd decide`\n",
    });
  });

  it("exits 4 when the hub or the node cannot be reached", async () => {
    const offline = answering({ error: { code: "machine_offline", message: "fleetd hub unreachable; the node keeps retrying — try again shortly" } });
    expect(await leadCommand(ask, { env: {}, cwd: "/src/api", send: offline.send })).toEqual({
      code: 4,
      stdout: "",
      stderr: "fleetd: fleetd hub unreachable; the node keeps retrying — try again shortly\n",
    });
    const noNode = answering({ unreachable: "no node" });
    expect((await leadCommand(ask, { env: {}, cwd: "/src/api", send: noNode.send })).code).toBe(4);
  });

  it("exits 2 on a usage error without calling the node", async () => {
    const node = answering({ result: { op: "decisions_search", decisions: [] } });
    const result = await leadCommand(["decide", "--key", "a.b"], { env: {}, cwd: "/src/api", send: node.send });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/^fleetd: --value is required\n\nusage:\n/u);
    expect(node.sent).toEqual([]);
  });

  it("talks to a real node socket, and exits 4 with a plain reason when no node listens", async () => {
    const socketPath = path.join(dir, "node", "node.sock");
    const seen: Array<LeadCallFrame> = [];
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* serveLeadSocket(socketPath, (frame) =>
          Effect.sync(() => {
            seen.push(frame);
            return { t: "lead_result", id: frame.id, result: { op: "decisions_search", decisions: [decision] } } as const;
          }),
        );
        return yield* Effect.promise(() =>
          leadCommand(["decisions", "search", "health"], { env: { FLEETD_NODE_SOCK: socketPath }, cwd: dir }),
        );
      }).pipe(Effect.scoped, Effect.provide(Logger.layer([]))),
    );
    expect(result).toEqual({
      code: 0,
      stdout: "D3 api.health.path = /healthz (project, by human)\nNext: use these answers; do not ask about these keys again.\n",
      stderr: "",
    });
    expect(seen).toMatchObject([{ cwd: dir, call: { op: "decisions_search", query: "health" } }]);

    const down = await leadCommand(["decisions", "search", "health"], { env: { FLEETD_NODE_SOCK: socketPath }, cwd: dir });
    expect(down).toEqual({
      code: 4,
      stdout: "",
      stderr: `fleetd: fleetd hub unreachable: no fleetd node is listening at ${socketPath} (set FLEETD_NODE_SOCK if it is elsewhere) — tell the human the node is down and carry on\n`,
    });
  });
});
