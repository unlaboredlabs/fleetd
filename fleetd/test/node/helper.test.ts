// The session-host helper: found beside the Bun build or named, never the Bun build or a script that runs it, and a
// node without one is degraded and starts no session.
import { expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HELPER, NO_HELPER, findHelper } from "../../src/node/runner/helper.ts";
import { SessionService } from "../../src/node/sessions/index.ts";
import { runnerProblem } from "../../src/hub/link/server.ts";
import { tempHome } from "../helpers.ts";

const script = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};

// A probe runs claude, here a bun process, and a session host is one too: a loaded machine (CI, or a busy devbox) takes
// longer than bun's 5 s default.
setDefaultTimeout(30_000);

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
    // A Bun build that hands `session-host` on to a Rust host it finds, as src/cli/session_host.ts does: while a
    // lookup runs it refuses, so it isn't taken in place of the host.
    const handsOn = join(home.dir, "hands-on");
    mkdirSync(handsOn);
    script(join(handsOn, "fleetd"), `[ -n "$FLEETD_SESSION_HOST_LOOKUP" ] && exit 1\nexec '${join(import.meta.dir, "fake-host.sh")}' "$@"`);
    expect(findHelper({ PATH: `${handsOn}:${bin}`, BUN_BIN: process.execPath }, own)).toBeUndefined();
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

test("with claude logged in, a node without a session host still reads as degraded to the hub", async () => {
  const home = tempHome();
  const fake = join(home.dir, "fake-claude");
  script(fake, `exec '${process.execPath}' '${join(import.meta.dir, "../../../tests/lab/factory/fakeClaude.ts")}' "$@"`);
  const config = {
    home: join(home.dir, "node"),
    claudeEnv: join(home.dir, "claude.env"),
    baseEnv: { HOME: home.dir, PATH: process.env.PATH ?? "/usr/bin:/bin" },
    claudeBin: fake,
  };
  const without = await SessionService.start({ ...config, nativeBin: undefined });
  try {
    const info = await without.reprobe();
    expect(info).toMatchObject({ login: "unknown", problem: NO_HELPER });
    // What both hubs decide a machine's state by: the Bun hub's runnerProblem, as the Rust hub's runner_problem.
    expect(runnerProblem(info)).toBe(NO_HELPER);
  } finally {
    await without.stopAll();
  }
  const withHost = await SessionService.start({ ...config, home: join(home.dir, "node2"), nativeBin: join(import.meta.dir, "fake-host.sh") });
  try {
    const info = await withHost.reprobe();
    expect(info.login).toBe("logged_in");
    expect(runnerProblem(info)).toBeUndefined();
  } finally {
    await withHost.stopAll();
    home.done();
  }
});
