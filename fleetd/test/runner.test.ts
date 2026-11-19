// The hub's own runner (hub/runner): it runs only while a hosted provider is connected or a bot lives on it, joins
// once with an enroll code for its reserved id and links as a node after, starts again when it ends, and stops with
// the hub. Where hosted boxes can't be made from, it never runs. New bots go to a computer of the team's first.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { githubApps } from "../src/hub/github_app/index.ts";
import { RENEW_MS, runnerRepos, sendGithubTokens, TOKEN_LEFT_MS } from "../src/hub/runner/github.ts";
import { NodeBoxKey } from "../src/node/identity.ts";
import { keepTokens, useGithubTokens, withGithubTokens } from "../src/node/repos/github.ts";
import { seal } from "../src/shared/sealed_box.ts";
import { bestWorker } from "../src/hub/projects/inspect.ts";
import { type Child, dialUrl, logLine, Runner, unsupported } from "../src/hub/runner/index.ts";
import { writeConfig } from "../src/node/config.ts";
import { CAP_RUNNER, RUNNER_ID } from "../src/shared/sandbox.ts";
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
    t.hub.db.conn.query("INSERT INTO sandbox_providers (provider, sealed, domain, max_agents, check_json) VALUES ('boat', x'00', NULL, 2, NULL)").run();
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

test("the runner's own git with GitHub answers only with the hub's token for that repo, never a login of the hub's machine", async () => {
  const home = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-runner-git-"));
  const box = new NodeBoxKey(crypto.getRandomValues(new Uint8Array(32)));
  const sealed = (t: string) => Buffer.from(seal(Buffer.from(box.publicKey(), "base64"), new TextEncoder().encode(t))).toString("base64");
  expect(keepTokens(home, { "Acme/Shop": sealed("ghs_shop123"), "../evil": sealed("x"), "acme/other": "bm90IHNlYWxlZA==" }, box)).toBe(1);
  // A machine's own helper (a `gh` login) is there, and never asked.
  const gitconfig = join(home, "gitconfig");
  writeFileSync(gitconfig, "[credential]\n\thelper = !echo password=machine-login\n");
  const fill = (path: string) => {
    useGithubTokens(home);
    const env = withGithubTokens({ PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } as Record<string, string | undefined>);
    useGithubTokens(undefined);
    const r = Bun.spawnSync(["git", "credential", "fill"], { env: env as Record<string, string>, stdin: new TextEncoder().encode(`protocol=https\nhost=github.com\npath=${path}\n\n`) });
    return r.stdout.toString();
  };
  expect(fill("acme/shop.git")).toContain("password=ghs_shop123");
  const other = fill("acme/elsewhere.git");
  expect(other).not.toContain("machine-login");
  expect(other).not.toContain("ghs_shop123");
  // Off the runner, git is as it was.
  expect(withGithubTokens({})).toEqual({});
  rmSync(home, { recursive: true, force: true });
});

test("the hub sends the runner the App's token for each of its bots' repos, sealed to it, and the runner can't be removed", async () => {
  const t = testHub();
  const box = new NodeBoxKey(crypto.getRandomValues(new Uint8Array(32)));
  addMachine(t.hub, RUNNER_ID, { boxPubKey: box.publicKey(), runner: true });
  addProject(t.hub, RUNNER_ID, "p1");
  t.hub.db.conn
    .query("INSERT INTO repos (machine_id, project_id, name, checkout_machine_id, checkout_project_id, repo_key) VALUES (?, 'p1', 'shop', ?, 'p1', 'github.com/acme/shop')")
    .run(RUNNER_ID, RUNNER_ID);
  expect(runnerRepos(t.hub)).toEqual(["acme/shop"]);
  // Every token sent has the runner's whole wait till the next send left, never the hub's cached one with less.
  const asked: number[] = [];
  githubApps(t.hub).installationToken = async (repo: string, marginMs: number) => {
    asked.push(marginMs);
    return repo === "acme/shop" ? { token: "ghs_shop123", expiresMs: Date.parse("2026-11-08T13:00:00Z") } : undefined;
  };
  const sent: Record<string, unknown>[] = [];
  t.link.answer = async (_m, frame) => (sent.push(frame as never), { ok: true });
  // Not linked as the runner: nothing goes.
  await sendGithubTokens(t.hub);
  expect(sent).toEqual([]);
  t.link.link(RUNNER_ID, [CAP_RUNNER]);
  await sendGithubTokens(t.hub);
  expect(sent).toHaveLength(1);
  expect(asked).toEqual([TOKEN_LEFT_MS]);
  expect(TOKEN_LEFT_MS).toBeGreaterThan(RENEW_MS);
  const tokens = (sent[0] as { action: string; tokens: Record<string, string> }).tokens;
  expect((sent[0] as { action: string }).action).toBe("github_tokens");
  expect(JSON.stringify(sent)).not.toContain("ghs_shop123");
  expect(new TextDecoder().decode(box.open(new Uint8Array(Buffer.from(tokens["acme/shop"]!, "base64")))!)).toBe("ghs_shop123");
  const owner = { keyId: "k", name: "desk", prefix: "fld_x", grants: [{ role: "admin" as const, machines: "*" as const }], createdAt: new Date(0).toISOString(), kind: "human" as const };
  const out = await t.tools.call(t.hub, owner, "machine_remove", { machineId: RUNNER_ID });
  expect("error" in out && out.error.kind === "tool" && out.error.error.message).toBe("Hosted sandboxes are the hub's own, not a computer of the team's: they can't be removed.");
  t.done();
});

test("the runner's log lines reach the hub's log at the level the node gave them, never all as errors", () => {
  const said: string[] = [];
  const log = { debug: (t: string) => said.push(`DEBUG ${t}`), info: (t: string) => said.push(`INFO ${t}`), warn: (t: string) => said.push(`WARN ${t}`), error: (t: string) => said.push(`ERROR ${t}`) };
  logLine('2026-11-18T18:23:49.899Z INFO fleetd node starting {"machineId":"hosted"}', log);
  logLine("2026-11-18T18:23:49.899Z WARN a hosted box wasn't deleted", log);
  logLine("fleetd: the link to the hub failed: refused", log);
  expect(said).toEqual(['INFO runner: fleetd node starting {"machineId":"hosted"}', "WARN runner: a hosted box wasn't deleted", "INFO runner: fleetd: the link to the hub failed: refused"]);
});
