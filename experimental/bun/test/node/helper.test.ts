// The session-host helper: found beside the Bun build or named, never the Bun build or a script that runs it, and a
// node without one is degraded and starts no session.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HELPER, NO_HELPER, findHelper } from "../../src/node/runner/helper.ts";
import { SessionService } from "../../src/node/sessions/index.ts";
import { tempHome } from "../helpers.ts";

const script = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};

test("the helper beside the build, or the one named, hosts sessions; a fleetd that is the Bun build never counts", () => {
  const home = tempHome();
  try {
    const bin = join(home.dir, "bin");
    mkdirSync(bin);
    const own = join(bin, "fleetd");
    // The Bun build, as `session-host` finds it: not ported.
    script(own, 'echo "fleetd: not ported to Bun yet: src/node/runner" >&2; exit 1');
    expect(findHelper({ PATH: bin }, own)).toBeUndefined();
    // A `fleetd` elsewhere on PATH that wraps the Bun build answers the same: refused too.
    const other = join(home.dir, "other");
    mkdirSync(other);
    script(join(other, "fleetd"), `exec '${own}' "$@"`);
    expect(findHelper({ PATH: `${other}:${bin}` }, own)).toBeUndefined();
    // The Rust build beside it, as `bun run helper` puts it there.
    script(join(bin, HELPER), `exec '${join(import.meta.dir, "fake-host.sh")}' "$@"`);
    expect(findHelper({ PATH: "/usr/bin:/bin", BUN_BIN: process.execPath }, own)).toBe(join(bin, HELPER));
    expect(findHelper({ FLEETD_NATIVE_BIN: join(import.meta.dir, "fake-host.sh"), PATH: "" }, own)).toBe(join(import.meta.dir, "fake-host.sh"));
  } finally {
    home.done();
  }
});

test("a node without a session host says so in its runner info, and refuses a launch with the fix", async () => {
  const home = tempHome();
  const repo = join(home.dir, "repo");
  mkdirSync(repo);
  const service = await SessionService.start({
    home: join(home.dir, "node"),
    claudeEnv: join(home.dir, "claude.env"),
    baseEnv: { HOME: home.dir, PATH: process.env.PATH ?? "/usr/bin:/bin" },
    claudeBin: join(home.dir, "no-claude"),
    nativeBin: undefined,
  });
  try {
    const info = await service.reprobe();
    expect(info.problem).toStartWith(NO_HELPER);
    await service.handle({ id: "c1", call: { op: "project_upsert", projectId: "p1", title: "demo", workspaceRoot: repo } as never });
    const launched = await service.handle({
      id: "c2",
      call: { op: "launch", sessionId: "s1", projectId: "p1", runtimeMode: "full-access", workspace: { type: "root" }, prompt: "hi", runId: "r1" } as never,
    });
    expect(launched.result).toMatchObject({ err: { code: "runner_unavailable", message: NO_HELPER } });
  } finally {
    await service.stopAll();
    home.done();
  }
});
