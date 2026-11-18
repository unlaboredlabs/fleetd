// The hub's own runner (hub/runner): it runs only while a hosted provider is connected or a bot lives on it, joins
// once with an enroll code for its reserved id and links as a node after, starts again when it ends, and stops with
// the hub. Where hosted boxes can't be made from, it never runs. New bots go to a computer of the team's first.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { bestWorker } from "../src/hub/projects/inspect.ts";
import { type Child, dialUrl, Runner, unsupported } from "../src/hub/runner/index.ts";
import { writeConfig } from "../src/node/config.ts";
import { RUNNER_ID } from "../src/shared/sandbox.ts";
import { addMachine, addProject, testHub } from "./screens_helpers.ts";

function kit(why?: string) {
  const t = testHub();
  const spawned: { args: string[]; stdin?: string; end: (code: number) => void; killed?: string }[] = [];
  const spawn = (args: string[], stdin: string | undefined): Child => {
    let end!: (code: number) => void;
    const exited = new Promise<number | null>((r) => (end = r));
    const s: (typeof spawned)[number] = { args, ...(stdin !== undefined ? { stdin } : {}), end };
    spawned.push(s);
    return { exited, kill: (signal) => void ((s.killed = signal ?? "SIGTERM"), end(0)) };
  };
  const r = new Runner(t.hub, spawn, why);
  const connect = () =>
    t.hub.db.conn.query("INSERT INTO sandbox_providers (provider, sealed, domain, max_agents, check_json) VALUES ('e2b', x'00', NULL, 2, NULL)").run();
  return { t, r, spawned, connect };
}

test("it runs while a provider is connected, joins once for its own id, links as a node after, and stops with the hub", async () => {
  const { t, r, spawned, connect } = kit();
  r.start("http://127.0.0.1:4790");
  expect(spawned).toEqual([]);
  connect();
  r.sync();
  expect(spawned).toHaveLength(1);
  const [join_] = spawned;
  expect(join_!.args).toEqual(["node", "join", "--hub", "http://127.0.0.1:4790", "--token-file", "-", "--machine", RUNNER_ID, "--home", r.home, "--runner"]);
  // The code is the hub's own, for that id alone, and goes on stdin, never in its arguments.
  expect(join_!.stdin).toStartWith("fle_");
  expect(t.hub.auth.nodes.openEnrollTokens().map((c) => c.machineId)).toEqual([RUNNER_ID]);
  // Joined: it starts again as that node when it ends.
  writeConfig(r.home, { hub: "http://127.0.0.1:4790", machineId: RUNNER_ID, name: "Hosted sandboxes", enrolled: true, runner: true });
  r.stop();
  expect(join_!.killed).toBe("SIGTERM");
  r.sync();
  expect(spawned.at(-1)!.args).toEqual(["node", "run", "--home", r.home]);
  // Nothing hosted connected any more and no bot on it: it stops.
  t.hub.db.conn.query("DELETE FROM sandbox_providers").run();
  r.sync();
  expect(spawned.at(-1)!.killed).toBe("SIGTERM");
  expect(r.running).toBe(false);
  // A bot on it keeps it running with no provider (its lead and checkout are there).
  addProject(t.hub, RUNNER_ID, "p1");
  expect(r.wanted()).toBe(true);
  t.hub.shutdown.abort();
  expect(r.running).toBe(false);
  t.done();
});

test("where boxes can't be made from, it never runs, and says so", () => {
  expect(unsupported("linux", "x64")).toBeUndefined();
  expect(unsupported("darwin", "arm64")).toBe("this hub runs on darwin (arm64), and hosted sandboxes are made from Linux on x86_64: connect a computer of the team's to run agents");
  const { t, r, spawned, connect } = kit(unsupported("darwin", "arm64"));
  connect();
  r.start("http://127.0.0.1:4790");
  expect(spawned).toEqual([]);
  expect(existsSync(r.home)).toBe(false);
  t.done();
});

test("it dials the hub on loopback where the hub listens on every address", () => {
  expect(dialUrl("0.0.0.0", 4790)).toBe("http://127.0.0.1:4790");
  expect(dialUrl("::", 4790)).toBe("http://[::1]:4790");
  expect(dialUrl("100.64.0.7", 4790)).toBe("http://100.64.0.7:4790");
});

test("a new bot goes to a computer of the team's first, to the runner only when none can take it", () => {
  const w = (machineId: string, ready = true) => ({ machineId, connected: true, capable: true, ready, running: 0 });
  expect(bestWorker([w(RUNNER_ID), w("zed")])).toBe("zed");
  expect(bestWorker([w(RUNNER_ID), w("zed", false)])).toBe("zed");
  expect(bestWorker([w(RUNNER_ID), { ...w("zed"), connected: false }])).toBe(RUNNER_ID);
  const t = testHub();
  addMachine(t.hub, "devbox");
  // No computer takes the id of the hub's runner.
  const code = t.hub.auth.nodes.createEnrollToken(undefined, "test").token;
  expect(t.hub.auth.nodes.enrollNode(code, RUNNER_ID, "a".repeat(43))).toBe(`${RUNNER_ID}-2`);
  t.done();
});
