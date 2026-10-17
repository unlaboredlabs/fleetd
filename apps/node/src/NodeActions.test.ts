import os from "node:os";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { commitEmail, probeHost, runNodeAction } from "./NodeActions.ts";
import { T3RestartFailed } from "./T3Supervisor.ts";

const deps = { remint: Effect.void, probe: Effect.succeed({ diskPath: "/", diskFreeBytes: 1 }) };

describe("node actions", () => {
  it("probes the free space under a real directory", async () => {
    const probe = await Effect.runPromise(probeHost(os.tmpdir()));
    expect(probe.diskPath).toBe(os.tmpdir());
    expect(probe.diskFreeBytes).toBeGreaterThan(0);
  });

  it("reads the commit email from the service environment before git's config", async () => {
    expect(await Effect.runPromise(commitEmail({ GIT_AUTHOR_EMAIL: "1+w@users.noreply.github.com" }))).toEqual({
      gitEmail: "1+w@users.noreply.github.com",
      gitEmailFrom: "env",
    });
    expect(await Effect.runPromise(commitEmail({ GIT_COMMITTER_EMAIL: "c@example.com" }))).toMatchObject({ gitEmailFrom: "env" });
  });

  it("runs the configured T3 restart command and reports its failure in plain words", async () => {
    const ok = await Effect.runPromise(runNodeAction({ t: "node_action", id: "1", action: "restart_t3" }, { ...deps, restart: Effect.void }));
    expect(ok).toEqual({ t: "node_action_result", id: "1", ok: true, message: "ran the T3 restart command" });
    const failed = await Effect.runPromise(
      runNodeAction(
        { t: "node_action", id: "2", action: "restart_t3" },
        { ...deps, restart: Effect.fail(new T3RestartFailed({ exitCode: 5, stderrTail: "unit not found" })) },
      ),
    );
    expect(failed).toEqual({ t: "node_action_result", id: "2", ok: false, message: "restart command failed (exit 5): unit not found" });
  });
});
