import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Claim, Decision, LeadCallFrame, LeadResultFrame, Task } from "@fleetd/contracts";
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

describe("secret asks and gated runs", () => {
  it("files a secret ask as a credential with its sink and optional env name", () => {
    expect(
      parseLeadArgs(["ask", "--kind", "secret", "--key", "stripe.test_key", "--sink", "env:lab-a:/srv/app/.env", "--text", "Need the Stripe test key"]),
    ).toEqual({
      op: "ask",
      kind: "secret",
      key: "stripe.test_key",
      class: "credential",
      text: "Need the Stripe test key",
      sink: "env:lab-a:/srv/app/.env",
      blocks: "nothing",
      proceededOnRec: false,
    });
    expect(
      parseLeadArgs(["ask", "--kind", "secret", "--key", "stripe.test_key", "--sink", "env:lab-a:/srv/app/.env", "--env-name", "STRIPE_KEY", "--class", "money", "--text", "t"]),
    ).toMatchObject({ class: "money", envName: "STRIPE_KEY" });
    expect(parseLeadArgs(["ask", "--kind", "secret", "--key", "a.b", "--text", "t"])).toBe("a secret ask needs --sink env:<machine>:<path> or file:<machine>:<path>");
    expect(parseLeadArgs(["ask", "--kind", "secret", "--key", "a.b", "--sink", "env:lab-a:relative", "--text", "t"])).toMatch(/at \["sink"\]/u);
    expect(parseLeadArgs(["ask", "--key", "a.b", "--text", "t", "--rec", "r"])).toBe("--class is required");
  });

  it("takes a do ask's verify check as JSON", () => {
    const verify = { type: "http", url: "https://example.com/health", status: 200 };
    const step = JSON.stringify({ text: "Point the DNS", where: "browser" });
    expect(parseLeadArgs(["ask", "--kind", "do", "--key", "dns.cutover", "--class", "irreversible", "--text", "t", "--step", step, "--verify", JSON.stringify(verify)])).toMatchObject({
      kind: "do",
      verify,
    });
    expect(parseLeadArgs(["ask", "--kind", "do", "--key", "a.b", "--class", "product", "--text", "t", "--step", step, "--verify", "{"])).toMatch(/^--verify is not valid JSON/u);
  });

  it("builds a gated run with its exact argv, secrets by name and the 30-minute default", () => {
    expect(
      parseLeadArgs([
        "gated",
        "run",
        "--class",
        "irreversible",
        "--argv",
        '["sh","-c","echo deployed > /tmp/fleetd-gated-test"]',
        "--reason",
        "prod deploy test",
        "--secret-env",
        "STRIPE=stripe.test_key",
        "--secret-env",
        "TOKEN=gh.deploy-token",
      ]),
    ).toEqual({
      op: "gated_run",
      argv: ["sh", "-c", "echo deployed > /tmp/fleetd-gated-test"],
      class: "irreversible",
      reason: "prod deploy test",
      secretEnv: [
        { name: "STRIPE", secretKey: "stripe.test_key" },
        { name: "TOKEN", secretKey: "gh.deploy-token" },
      ],
      timeoutSec: 1800,
    });
    const base = ["gated", "run", "--class", "money", "--reason", "r"];
    expect(parseLeadArgs([...base, "--argv", '["true"]', "--cwd", "/srv/app", "--timeout", "60", "--workstream", "W2"])).toMatchObject({
      cwd: "/srv/app",
      timeoutSec: 60,
      workstreamId: "W2",
    });
    expect(parseLeadArgs([...base, "--argv", "[true"])).toMatch(/^--argv is not valid JSON/u);
    expect(parseLeadArgs([...base, "--argv", '"true"'])).toBe(`--argv is a JSON array of strings, e.g. '["sh","-c","echo hi"]'`);
    expect(parseLeadArgs([...base, "--argv", '["true"]', "--secret-env", "NOEQUALS"])).toBe("--secret-env is NAME=<secret key>, got 'NOEQUALS'");
    expect(parseLeadArgs([...base, "--argv", '["true"]', "--timeout", "1801"])).toMatch(/at \["timeoutSec"\]/u);
    expect(parseLeadArgs(["gated", "run", "--class", "product", "--argv", '["true"]', "--reason", "r"])).toMatch(/at \["class"\]/u);
    expect(parseLeadArgs(["gated", "run", "--argv", '["true"]', "--reason", "r"])).toBe("--class is required");
    expect(parseLeadArgs(["gated", "list"])).toMatch(/^expected fleetd gated run/u);
  });

  it("says nothing runs before a human approves it", () => {
    expect(formatResult({ op: "gated_run", askId: "A7" as never, state: "open" })).toBe(
      "A7 open: the command is stored and waits for a human to approve it; nothing runs before that.\nNext: carry on with other work; the exit code and output tail arrive in a wake.\n",
    );
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
        "--model", "claude-haiku-5-5", "--effort", "low", "--estimate", "5", "--serves", "done:1",
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
      serves: "done:1",
    });
    expect(
      parseLeadArgs(["task", "spawn", "--workstream", "W1", "--title", "review", "--kind", "review", "--qa", "--pr", "https://github.com/o/r/pull/7", "--prompt", "review it"]),
    ).toMatchObject({ op: "task_spawn", kind: "review", qa: true, pr: "https://github.com/o/r/pull/7" });
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
    expect(parseLeadArgs(["task", "spawn", "--workstream", "W1", "--title", "x", "--prompt", "y", "--serves", "done:0"])).toMatch(/at least one area/u);
    expect(parseLeadArgs(["task", "spawn", "--workstream", "W1", "--title", "x", "--prompt", "y", "--areas", "docs"])).toMatch(/needs --serves: say what this serves/u);
    expect(parseLeadArgs(["task", "spawn", "--workstream", "W1", "--title", "x", "--prompt", "y", "--kind", "review"])).toMatch(/needs --pr/u);
    expect(parseLeadArgs(["task", "spawn", "--title", "x", "--prompt", "y"])).toBe("--workstream is required");
    expect(parseLeadArgs(["task", "spawn", "--workstream", "W1", "--title", "x", "--prompt", "y", "--areas", "docs", "--serves", "done:0", "--effort", "huge"])).toMatch(/^invalid input/u);
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
      threadRef: { machineId: "lab-a", threadId: "t9" } as NonNullable<Task["threadRef"]>,
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

const SHA = "0123456789abcdef0123456789abcdef01234567";
const failedClaim: Claim = {
  claimId: "C1" as Claim["claimId"],
  workstreamId: "W1" as Claim["workstreamId"],
  by: "lead:lab-a/p",
  at: "2026-10-17T10:00:00.000Z",
  outcome: "fail",
  results: [
    {
      checkIndex: 0,
      spec: { type: "http", url: "http://127.0.0.1:8080/healthz", status: 200 },
      result: "pass",
      evidence: "GET → 200",
      ranBy: "hub",
      at: "2026-10-17T10:00:00.000Z",
    },
    {
      checkIndex: 1,
      spec: { type: "cmd", machineId: "lab-a" as never, argv: ["test", "-f", "docs/x.md"], expectExit: 0 },
      result: "fail",
      evidence: "`test -f docs/x.md` in /w exited 1 (expected 0)",
      exitCode: 1,
      ranBy: "node",
      at: "2026-10-17T10:00:00.000Z",
    },
  ],
};

describe("claim and review commands", () => {
  it("parses claim done and review verdict, taking a SHA in any case", () => {
    expect(parseLeadArgs(["claim", "done", "--workstream", "W1"])).toEqual({ op: "claim_done", workstreamId: "W1" });
    expect(
      parseLeadArgs(["review", "verdict", "--task", "T3", "--sha", SHA.toUpperCase(), "--blocking", "0", "--non-blocking", "2", "--summary", "reads well"]),
    ).toEqual({ op: "review_verdict", taskId: "T3", prHeadSha: SHA, blocking: 0, nonBlocking: 2, summary: "reads well" });
  });

  it("refuses a short SHA, a count that is not a number and a missing flag with the fix", () => {
    const verdict = ["review", "verdict", "--task", "T3", "--blocking", "0", "--non-blocking", "0", "--summary", "ok"];
    expect(parseLeadArgs([...verdict, "--sha", "0123abc"])).toMatch(/^--sha must be the full commit SHA .*git rev-parse HEAD/u);
    expect(parseLeadArgs(["review", "verdict", "--task", "T3", "--sha", SHA, "--blocking", "none", "--non-blocking", "0", "--summary", "ok"])).toBe(
      "--blocking is a count of findings, got 'none'",
    );
    expect(parseLeadArgs(verdict)).toBe("--sha is required");
    expect(parseLeadArgs(["claim", "done"])).toBe("--workstream is required");
    expect(parseLeadArgs(["task", "spawn", "--workstream", "W1", "--title", "x", "--areas", "docs", "--prompt", "y"])).toBe(
      "a write task needs --serves: say what this serves: --serves done:<n> | issue:<ref> | defect:<text> | ask:<id>",
    );
    expect(parseLeadArgs(["claim", "W1"])).toBe("expected fleetd claim done --workstream <W>");
  });

  it("shows ✓ only for checks that passed, quotes the evidence of the rest, and exits 1 on a failed claim", async () => {
    const out = await leadCommand(["claim", "done", "--workstream", "W1"], {
      env: {},
      cwd: "/w",
      send: async (_, frame) => ({
        t: "lead_result",
        id: frame.id,
        result: { op: "claim_done", claimId: failedClaim.claimId, workstreamId: failedClaim.workstreamId, state: "verifying", claim: failedClaim, next: "done:1 did not pass; fix it, then claim again." },
      }),
    });
    expect(out).toEqual({
      code: 1,
      stderr: "",
      stdout: [
        "C1 on W1 failed: 1 of 2 checks did not pass. W1 is verifying, not done.",
        "✓ done:0 http: pass",
        "✗ done:1 cmd: fail, exit 1",
        "    > `test -f docs/x.md` in /w exited 1 (expected 0)",
        "Next: done:1 did not pass; fix it, then claim again.",
        "",
      ].join("\n"),
    });
    const passed: Claim = { ...failedClaim, claimId: "C2" as Claim["claimId"], outcome: "pass", results: [failedClaim.results[0]!] };
    expect(formatResult({ op: "claim_done", claimId: passed.claimId, workstreamId: passed.workstreamId, state: "done", claim: passed })).toBe(
      "C2 on W1 passed: fleetd ran all 1 done-when checks and each passed. W1 is done.\n✓ done:0 http: pass\nNext: spawn nothing more for W1.\n",
    );
    expect(formatResult({ op: "review_verdict", verdict: { taskId: "T3" as never, prHeadSha: SHA, blocking: 0, nonBlocking: 2, summary: "ok" } })).toBe(
      "Recorded the verdict of T3 at 0123456789ab: 0 blocking, 2 non-blocking.\nNext: end with your one-paragraph result and stop.\n",
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

describe("change commands", () => {
  const PR = "https://github.com/wynn-dev/fleetd-testbed/pull/4";

  it("parses change enqueue with --pr or a positional URL, and change status", () => {
    expect(parseLeadArgs(["change", "enqueue", "--pr", PR, "--task", "T2", "--serves", "done:1", "--tier", "M"])).toEqual({
      op: "change_enqueue",
      prUrl: PR,
      taskId: "T2",
      serves: "done:1",
      tier: "M",
    });
    expect(parseLeadArgs(["change", "enqueue", PR, "--workstream", "W1"])).toEqual({ op: "change_enqueue", prUrl: PR, workstreamId: "W1" });
    expect(parseLeadArgs(["change", "status", "X3"])).toEqual({ op: "change_status", changeId: "X3" });
    expect(parseLeadArgs(["change", "enqueue"])).toBe("--pr is required");
    expect(parseLeadArgs(["change", "status", "X3", "--task", "T1"])).toBe("--task does not apply to fleetd change status");
    expect(parseLeadArgs(["change", "merge", "X3"])).toBe("expected fleetd change enqueue|status");
  });

  it("shows where a Change is, its reviews and why it is parked", () => {
    const out = formatResult({
      op: "change_status",
      change: {
        changeId: "X3" as never,
        projectRef: { machineId: "lab-a", projectId: "p1" } as never,
        repo: "wynn-dev/fleetd-testbed",
        prNumber: 4,
        prUrl: PR,
        branch: "fleetd/T2-beta",
        taskId: "T2" as never,
        workstreamId: "W1" as never,
        serves: "done:1",
        tier: "M",
        headSha: SHA,
        state: "needs_rebase",
        reviews: [{ taskId: "T5" as never, prHeadSha: SHA, patchId: SHA, blocking: 0, nonBlocking: 1 }],
        lastError: "conflicts with origin/main in alpha.md",
        createdAt: "2026-10-17T10:00:00.000Z",
        updatedAt: "2026-10-17T10:00:00.000Z",
      },
      next: "nothing unless its author is gone.",
    });
    expect(out).toBe(
      [
        "X3 wynn-dev/fleetd-testbed#4 needs_rebase (tier M, serves done:1, by T2)",
        `  ${PR} at ${SHA.slice(0, 12)}`,
        `  reviews: T5 0 blocking at ${SHA.slice(0, 12)}`,
        "  > conflicts with origin/main in alpha.md",
        "Next: nothing unless its author is gone.",
        "",
      ].join("\n"),
    );
  });
});
