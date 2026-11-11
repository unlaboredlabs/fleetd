// Ports crates/fleetd/src/node/sessions/env_tests.rs's a_machine_whose_claude_isnt_logged_in_runs_on_the_account_the_hub_
// sealed_to_it: the runner probe of a node whose claude has no login of its own, before and after the hub seals it
// its Claude account.
import { expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runnerProblem } from "../../src/hub/link/server.ts";
import { loadOrCreateBoxKey } from "../../src/node/identity.ts";
import { SessionService } from "../../src/node/sessions/index.ts";
import { tempHome } from "../helpers.ts";

// Each probe runs the stand-in claude, a bun process: a loaded machine takes longer than bun's 5 s default.
setDefaultTimeout(30_000);

/**
 * A machine whose claude has no login of its own runs on the Claude account the hub sealed to its node. Read as logged
 * out, the hub would show it degraded and refuse every message to its agents. Its runner is logged in on the account the
 * node holds, and logged out again once the hub takes it back.
 */
test("a machine whose claude isn't logged in runs on the account the hub sealed to it", async () => {
  const home = tempHome();
  const nodeHome = join(home.dir, "node");
  const boxKey = loadOrCreateBoxKey(nodeHome);
  // A stand-in claude that answers the initialize probe logged in only on a key or token in its env, as claude does.
  const script = join(home.dir, "claude.ts");
  writeFileSync(
    script,
    `if (process.argv.includes("--version")) { console.log("2.1.302 (Claude Code)"); process.exit(0); }
for await (const line of console) {
  const id = JSON.parse(line).request_id;
  const account = process.env.ANTHROPIC_API_KEY ? { apiKeySource: "ANTHROPIC_API_KEY" } : process.env.CLAUDE_CODE_OAUTH_TOKEN ? { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" } : {};
  console.log(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: id, response: { claudeCodeVersion: "2.1.302", account } } }));
}
`,
  );
  const claude = join(home.dir, "claude");
  writeFileSync(claude, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
  chmodSync(claude, 0o755);
  const service = await SessionService.start({
    home: nodeHome,
    claudeEnv: join(home.dir, "claude.env"),
    baseEnv: { HOME: home.dir, PATH: process.env.PATH ?? "/usr/bin:/bin" },
    claudeBin: claude,
    fleetd: [join(import.meta.dir, "fake-host.sh")],
    boxKey,
  });
  const secret = (set?: { sealed: string }) =>
    service.handle({ id: "c1", call: { op: "claude_account_secret", account: { kind: "hub" }, ...(set ? { set } : {}) } as never });
  try {
    let info = await service.reprobe();
    expect(info.login).toBe("logged_out");
    expect(runnerProblem(info)).toContain("claude is not logged in");

    await secret({ sealed: Buffer.from(boxKey.seal(Buffer.from("sk-ant-api03-hub"))).toString("base64") });
    info = await service.reprobe();
    expect(info).toMatchObject({ login: "logged_in", loginKind: "api_key" });
    expect(runnerProblem(info)).toBeUndefined();

    await secret();
    expect((await service.reprobe()).login).toBe("logged_out");
  } finally {
    await service.stopAll();
    home.done();
  }
});
