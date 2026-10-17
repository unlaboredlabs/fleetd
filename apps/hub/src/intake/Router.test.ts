import { PlaybookName, type MachineId, type ProjectId } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vitest";
import { makeFakeClaude, result, type Reply } from "./fakeClaude.ts";
import * as Router from "./Router.ts";

const projects: ReadonlyArray<Router.RouterProject> = [
  { ref: { machineId: "lab-a" as MachineId, projectId: "p-a" as ProjectId }, title: "repo-a", root: "/lab/repo-a", recentIntents: ["add a /health endpoint"] },
  { ref: { machineId: "lab-b" as MachineId, projectId: "p-b" as ProjectId }, title: "repo-b", root: "/lab/repo-b", recentIntents: [] },
];
const toA = { projectRef: { machineId: "lab-a", projectId: "p-a" }, template: "bugfix", reason: "repo-a has the README" };
const TEXT = "fix: the lab README has a typo";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
});

const route = (replies: ReadonlyArray<Reply>, options: { readonly model?: string } = {}) => {
  const fake = makeFakeClaude(replies);
  cleanups.push(fake.cleanup);
  return Effect.runPromise(
    Effect.gen(function* () {
      const router = yield* Router.make({ home: fake.home, env: fake.env, ...options });
      return { outcome: yield* router.route({ text: TEXT, projects }), calls: fake.calls() };
    }),
  );
};

describe("router prompt", () => {
  it("names every template and renders projects and the intent", () => {
    const template = Router.readRouterPrompt();
    for (const name of PlaybookName.literals) expect(template).toContain(`- ${name}:`);
    const prompt = Router.renderRouterPrompt(template, { text: TEXT, projects });
    expect(prompt).toContain('{"machineId":"lab-a","projectId":"p-a","title":"repo-a","folder":"repo-a","recentIntents":["add a /health endpoint"]}');
    expect(prompt).toContain(TEXT);
    expect(prompt).not.toMatch(/\{\{\w+\}\}/u);
  });
});

describe("judgeAnswer", () => {
  it.each([
    ["a bare object", JSON.stringify(toA), "ok"],
    ["an object in a code fence with prose", `Here you go:\n\`\`\`json\n${JSON.stringify(toA)}\n\`\`\``, "ok"],
    ["no JSON", "repo-a, I think", "invalid"],
    ["broken JSON", '{"projectRef": {', "invalid"],
    ["an unknown template", JSON.stringify({ ...toA, template: "chore" }), "invalid"],
    ["a project not offered", JSON.stringify({ ...toA, projectRef: { machineId: "lab-a", projectId: "p-z" } }), "invalid"],
    ["a reason over one line", JSON.stringify({ ...toA, reason: "two\nlines" }), "invalid"],
    ["projectRef null", JSON.stringify({ projectRef: null, template: "feature", reason: "both repos have a README" }), "unsure"],
  ])("%s → %s", (_, text, kind) => {
    expect(Router.judgeAnswer(text, projects).kind).toBe(kind);
  });
});

describe("IntakeRouter", () => {
  it("runs claude -p once with its own config dir, the hub's login env and no CLAUDE* session variables", async () => {
    const { outcome, calls } = await route([result(toA)]);
    expect(outcome.result).toEqual(toA);
    expect(outcome.runs).toEqual([{ kind: "orchestrator", model: "claude-haiku-5-5", durationMs: expect.any(Number), ok: true, inputTokens: 120, outputTokens: 30 }]);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.args).toEqual(["-p", "--output-format", "json", "--model", "claude-haiku-5-5", "--tools", "", "--strict-mcp-config", "--no-session-persistence"]);
    expect(call.env.CLAUDE_CONFIG_DIR).toMatch(/\/hub\/claude-router$/u);
    expect(call.env.ANTHROPIC_BASE_URL).toBe("http://proxy.invalid");
    expect(call.env.ANTHROPIC_AUTH_TOKEN).toBe("test-token");
    expect(Object.keys(call.env).filter((k) => k.startsWith("CLAUDE"))).toEqual(["CLAUDE_CONFIG_DIR"]);
    expect(call.prompt).toContain(TEXT);
    expect(call.prompt).toContain('"title":"repo-b"');
  });

  it("uses the configured model", async () => {
    const { calls, outcome } = await route([result(toA)], { model: "claude-sonnet-5-5" });
    expect(calls[0]!.args).toContain("claude-sonnet-5-5");
    expect(outcome.runs[0]!.model).toBe("claude-sonnet-5-5");
  });

  it("retries once after an invalid answer, saying what was wrong", async () => {
    const { outcome, calls } = await route([result({ ...toA, projectRef: { machineId: "lab-a", projectId: "p-z" } }), result(toA)]);
    expect(outcome.result).toEqual(toA);
    expect(outcome.runs.map((r) => r.ok)).toEqual([false, true]);
    expect(outcome.runs[0]!.error).toContain("lab-a/p-z is not one of the listed projects");
    expect(calls[1]!.prompt).toContain("Your previous answer was not usable (lab-a/p-z is not one of the listed projects)");
  });

  it("gives up after two invalid runs: a CLI error, then no JSON", async () => {
    const { outcome, calls } = await route([
      { stdout: JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "API Error: 529" }) },
      result("repo-a"),
    ]);
    expect(outcome.result).toBeUndefined();
    expect(outcome.why).toContain("the router gave no usable answer twice (the answer has no JSON object)");
    expect(outcome.runs.map((r) => r.error)).toEqual(["the CLI reported an error: API Error: 529", "the answer has no JSON object"]);
    expect(calls).toHaveLength(2);
  });

  it("counts a failed exit and garbage output as invalid", async () => {
    const { outcome } = await route([{ stdout: "", exit: 1 }, { stdout: "not json" }]);
    expect(outcome.result).toBeUndefined();
    expect(outcome.runs.map((r) => r.error)).toEqual(["the CLI printed no JSON result", "the CLI printed no JSON result"]);
  });

  it("does not retry when the model says no project fits", async () => {
    const { outcome, calls } = await route([result({ projectRef: null, template: "bugfix", reason: "both repos have a README" })]);
    expect(outcome).toMatchObject({ why: "both repos have a README", runs: [{ ok: true }] });
    expect(outcome.result).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("reports a missing claude binary as the reason", async () => {
    const fake = makeFakeClaude([]);
    cleanups.push(fake.cleanup);
    const outcome = await Effect.runPromise(
      Effect.flatMap(Router.make({ home: fake.home, env: { PATH: "/nonexistent" } }), (router) => router.route({ text: TEXT, projects })),
    );
    expect(outcome.result).toBeUndefined();
    expect(outcome.runs[0]!.error).toMatch(/^could not start claude: .*ENOENT/u);
  });
});
