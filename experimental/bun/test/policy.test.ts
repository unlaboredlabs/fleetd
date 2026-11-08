// Ports crates/fleetd/src/hub/policy.rs's tests: the repo policy file, its checks, and its 60 s cache.
import { expect, test } from "bun:test";
import { DEFAULT_BRANCH_PREFIX, parsePolicy, Policies, ReadFailure } from "../src/hub/policy/index.ts";
import { ToolError } from "../src/shared/errors.ts";
import { Hub } from "../src/hub/api/hub.ts";
import { found } from "../src/hub/executor/sessions.ts";
import { start } from "../src/hub/mcp_servers/loops.ts";
import { HubDb } from "../src/hub/store/db.ts";

test("reads tools and the branch prefix and ignores other keys", () => {
  const text = 'areas:\n  docs: ["docs/**"]\ndefaults:\n  model: claude-sonnet-5-5\n  effort: high\ntools:\n  deny: ["Bash(git push:*)"]\nbranchPrefix: team/\n';
  expect(parsePolicy(text)).toEqual({ tools: { allow: [], deny: ["Bash(git push:*)"] }, branchPrefix: "team/" });
  expect(() => parsePolicy("defaults:\n  effort: medum\n")).not.toThrow();
  expect(parsePolicy("\n")).toEqual({});
});

test("refuses broken files with a message and a fix", () => {
  for (const text of ["tools: {deny: [x\n", "tools:\n  deny: Bash\n", "branchPrefix: no slash\n"]) {
    let e: ToolError | undefined;
    try {
      parsePolicy(text);
    } catch (err) {
      e = err as ToolError;
    }
    expect(e?.code).toBe("invalid");
    expect(e?.message.startsWith(".fleetd/policy.yaml is invalid: ")).toBe(true);
    expect(e?.fix).toContain("Fix .fleetd/policy.yaml in the project's checkout on its machine.");
  }
});

test("the default when absent, a 60 s cache, and an offline machine read again", async () => {
  let now = 1_792_231_200_000;
  let reads = 0;
  let text: string | undefined;
  let offline = false;
  const p = new Policies(
    async () => {
      reads++;
      if (offline) throw new ReadFailure(false, new ToolError("machine_offline", "offline", "wait"));
      return text;
    },
    { now: () => now },
  );
  const a = { machineId: "lab-a", projectId: "pa" };
  expect(await p.branchPrefix(a)).toBe(DEFAULT_BRANCH_PREFIX);
  text = "branchPrefix: team/\n";
  expect(await p.branchPrefix(a)).toBe(DEFAULT_BRANCH_PREFIX);
  expect(reads).toBe(1);
  now += 60_001;
  expect(await p.branchPrefix(a)).toBe("team/");
  p.invalidate(a);
  offline = true;
  const quiet = console.warn;
  console.warn = () => {};
  expect(await p.branchPrefix(a)).toBeUndefined();
  expect(await p.branchPrefix(a)).toBeUndefined();
  console.warn = quiet;
  expect(reads).toBe(4);
});

test("a launch's tool rules come from the file, none without one, and a broken file refuses it", async () => {
  let text: string | undefined;
  let now = 1_792_231_200_000;
  const p = new Policies(async () => text, { now: () => now });
  const a = { machineId: "lab-a", projectId: "pa" };
  expect(await p.tools(a)).toEqual({ allow: [], deny: [] });
  text = 'tools:\n  allow: ["Bash(npm test:*)"]\n  deny: ["Bash(git push:*)", "WebFetch"]\n';
  p.invalidate(a);
  expect(await p.tools(a)).toEqual({ allow: ["Bash(npm test:*)"], deny: ["Bash(git push:*)", "WebFetch"] });
  text = "tools: [oops]\n";
  now += 60_001;
  await expect(p.tools(a)).rejects.toBeInstanceOf(ToolError);
});

test("the hub's start fills the launch hook with the policy file's rules", async () => {
  const hub = new Hub({ home: "", listen: { host: "127.0.0.1", port: 0 } }, HubDb.memory(), { now: () => 0 });
  const saved = found.toolRules;
  try {
    hub.area("policy", (h) => new Policies(async () => 'tools:\n  deny: ["WebFetch"]\n', h.clock));
    start(hub);
    expect(await found.toolRules!(hub, { machineId: "lab-a", projectId: "pa" })).toEqual({ allow: [], deny: ["WebFetch"] });
  } finally {
    hub.shutdown.abort();
    found.toolRules = saved;
  }
});
