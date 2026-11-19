// The hosted place (src/node/place/hosted.ts) end to end against E2B's stand-in server, its box running here as the
// provider would run it: setup's command boots the box and runs in it, the session host starts there with a stand-in
// claude and its lines come over the box's link, a node that lets go re-adopts it, a session on the machine's own
// login is refused, the session's ports reach the machine though setup made the box, Claude's endpoint is the box's
// to reach (the team's tailnet, never a relay), and stop brings the work back and deletes the box. A box on this machine shares its paths, so
// the worktree's sync is a no-op here (hosted_files.test.ts tests it apart).
import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { connect, createServer } from "node:net";
import { e2bStandIn, KEY, localRunner, type StandIn } from "./stand_ins.ts";
import { provider } from "../../src/sandbox/providers/index.ts";
import { Boxes, setBoxes } from "../../src/node/sandbox/remote/boxes.ts";
import { BOX_DIR } from "../../src/node/sandbox/remote/bootstrap.ts";
import { BOX_CLAUDE, HostedDown, hostedPlace, hostedProbe, nobodyPid, readRecord } from "../../src/node/place/hosted.ts";
import { NodeTailnet, setNodeTailnet } from "../../src/node/sandbox/tailnet.ts";
import { pick, placeAt } from "../../src/node/place/index.ts";
import { LeadRelay } from "../../src/node/lead/index.ts";
import { Masker } from "../../src/node/mask.ts";
import { stop as stopHost, type RunnerEvent } from "../../src/node/runner/host.ts";

const MAIN = join(import.meta.dir, "../../src/main.ts");
const tmp = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-hosted-place-"));
let server: StandIn | undefined;
let cleanup = async () => {};
afterEach(async () => {
  server?.stop();
  await cleanup();
});
afterAll(async () => {
  setBoxes(undefined);
  rmSync(tmp, { recursive: true, force: true });
});

const FLEETD = new TextEncoder().encode(`#!/bin/sh\nexec ${process.execPath} ${MAIN} "$@"\n`);
const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

/** Says it started, then runs until its stdin closes. */
const CLAUDE = `#!/bin/sh
echo '{"type":"system","subtype":"init","claude_code_version":"2.1.302","model":"m1","cwd":"/fake"}'
exec cat > /dev/null
`;

function sh(cwd: string, cmd: string): string {
  const r = Bun.spawnSync(["sh", "-c", cmd], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
  if (r.exitCode !== 0) throw new Error(`${cmd}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

async function setup() {
  // Each test its own node, home and repo.
  const base = mkdtempSync(join(tmp, "t-"));
  const home = join(base, "node");
  const HOME = join(base, "home");
  mkdirSync(home, { recursive: true });
  mkdirSync(HOME, { recursive: true });
  const claude = join(base, "claude");
  writeFileSync(claude, CLAUDE);
  chmodSync(claude, 0o755);
  BOX_CLAUDE.path = claude;
  // A stand-in box has no curl of a box's: its check of Claude is the test's.
  hostedProbe.probe = async () => {};
  const repo = join(base, "repo");
  sh(base, `git init -q -b main ${repo} && cd ${repo} && echo a > a.txt && git add -A && git commit -qm one && git config extensions.worktreeConfig true`);
  const cwd = join(home, "worktrees", "T1");
  sh(repo, `git worktree add -q -b fleetd/T1 ${cwd}`);
  const local = localRunner(join(base, "boxes"), BOX_DIR);
  cleanup = local.cleanup;
  const s = e2bStandIn(local.runner);
  server = s;
  local.track(s);
  const boxes = new Boxes(home, "devbox", { open: (b) => b }, {
    provider: (p, auth) => provider(p, auth, { urls: { api: s.url, sandbox: (box, port) => `${s.url}/box/${box}/${port}` }, pollMs: 5 }),
    source: () => ({ sha256: sha(FLEETD), bytes: async () => FLEETD }),
  });
  boxes.setKeys({ e2b: Buffer.from(JSON.stringify({ provider: "e2b", key: KEY })).toString("base64") });
  boxes.wire({ lead: { relay: new LeadRelay(), identify: () => ({ kind: "none" }) as never, maskFor: () => new Masker([]) } });
  setBoxes(boxes);
  const env = { HOME, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, FLEETD_NODE_SOCK: join(home, "node.sock"), TMPDIR: join(home, "tmp", "s1") };
  return { s, home, cwd, env, boxes };
}

const next = async (link: { next(): Promise<RunnerEvent | undefined> }) =>
  Promise.race([link.next(), Bun.sleep(15_000).then(() => "timed out")]);

test("setup boots the box and runs there; the session runs in it, is re-adopted, and stop deletes the box", async () => {
  const { s, home, cwd, env } = await setup();
  const dir = join(home, "hosts", "s1");
  const place = hostedPlace("e2b", "s1", dir);
  const ran = await place.run({ cwd, argv: ["sh", "-c", "echo set up > setup.txt; echo ok"], timeoutSec: 30, env, scrub: [] });
  expect(ran).toMatchObject({ exitCode: 0 });
  expect(readFileSync(join(cwd, "setup.txt"), "utf8")).toBe("set up\n");
  const record = readRecord(dir)!;
  expect(record).toMatchObject({ kind: "hosted", provider: "e2b", session: "s1", cwd });
  expect(s.boxes.size).toBe(1);
  // The box's create carried no secret of the session's or the box's own.
  expect(JSON.stringify([...s.boxes.values()][0].req)).not.toContain(record.secret);

  // On the machine's own login, it is refused in plain words.
  await expect(place.start({ fleetd: [], dir, sessionId: "s1", program: "claude", args: [], cwd, env })).rejects.toThrow("machine's own Claude login");

  // The browser's proxy on this machine: setup made the box without its port, and the session's start forwards it.
  const echo = createServer((sock) => sock.pipe(sock)).listen(0, "127.0.0.1");
  await new Promise((r) => echo.once("listening", r));
  const cdp = (echo.address() as { port: number }).port;
  const link = await place.start({
    fleetd: [],
    dir,
    sessionId: "s1",
    program: "claude",
    args: [],
    cwd,
    env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: "tok-123", FLEETD_RUNNER_SESSION: "s1.mark", AGENT_BROWSER_CDP: `ws://127.0.0.1:${cdp}/devtools/browser/x` },
  });
  expect(readRecord(dir)!.tcp).toEqual([cdp]);
  // In the box (its loopback here is 127.0.0.2), the port reaches this machine's proxy.
  const said = await new Promise<string>((resolve, reject) => {
    const c = connect({ host: "127.0.0.2", port: cdp }, () => c.write("ping"));
    c.once("data", (d) => (resolve(d.toString()), c.end()));
    c.once("error", reject);
  });
  expect(said).toBe("ping");
  echo.close();
  expect(link.pid).toBe(nobodyPid("s1"));
  expect(nobodyPid("s1")).toBeGreaterThan(2 ** 22);
  expect(JSON.stringify(await next(link))).toContain("m1");
  // The record says where it runs: the node finds its place again from the host dir alone.
  expect(placeAt(dir).kind).toBe("hosted");
  // The node lets go (its restart); the next node re-adopts the session from the record.
  await link.detach();
  expect(s.boxes.size).toBe(1);
  const again = await placeAt(dir).adopt(dir);
  expect(again).toBeDefined();
  expect(again!.pid).toBe(link.pid);

  await placeAt(dir).stop(dir);
  expect(s.boxes.size).toBe(0);
  expect(existsSync(dir)).toBe(false);
  // The node's sweep finds nothing of it left.
  await stopHost(dir);
}, 60_000);

test("a session whose bot picked E2B · 4 vCPU / 8 GB gets a box of exactly that: its own template's size", async () => {
  const { s, home, cwd, env } = await setup();
  const dir = join(home, "hosts", "s-big");
  const place = pick({ sessionId: "s-big", dir, role: "worker", account: true, hosted: "e2b", size: { cpu: 4, memGb: 8 } });
  expect(place.kind).toBe("hosted");
  expect(await place.run({ cwd, argv: ["true"], timeoutSec: 30, env, scrub: [] })).toMatchObject({ exitCode: 0 });
  const built = s.calls.filter((c) => c.method === "POST" && c.path === "/v3/templates");
  expect(built.map((c) => [c.body.cpuCount, c.body.memoryMB])).toEqual([[4, 8192]]);
  expect(built[0]!.body.name).toMatch(/-4c8g$/);
  await placeAt(dir).end(dir);
  expect(s.boxes.size).toBe(0);
});

test("a box calls Claude's endpoint as set, with nothing relayed; a private one it can't reach says to connect Tailscale", async () => {
  const { home, cwd, env } = await setup();
  const cfg = join(tmp, "cfg-tailnet");
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://100.104.249.49:8317" } }));
  const checked: string[] = [];
  let reaches = true;
  hostedProbe.probe = async (_box, url) => {
    checked.push(url);
    if (!reaches) throw new Error("the box can't reach Claude at 100.104.249.49:8317: curl: (28) Connection timed out");
  };
  const start = (id: string) =>
    hostedPlace("e2b", id, join(home, "hosts", id)).start({
      fleetd: [],
      dir: join(home, "hosts", id),
      sessionId: id,
      program: "claude",
      args: ["-p"],
      cwd,
      env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: "tok-123", CLAUDE_CONFIG_DIR: cfg, FLEETD_RUNNER_SESSION: `${id}.mark` },
    });
  const link = await start("s-tail");
  expect(checked).toEqual(["http://100.104.249.49:8317"]);
  expect(Object.keys(readRecord(join(home, "hosts", "s-tail"))!)).not.toContain("relays");
  expect(JSON.stringify(await next(link))).toContain("m1");
  await placeAt(join(home, "hosts", "s-tail")).stop(join(home, "hosts", "s-tail"));
  // Unreached with the team's tailnet off: the start refuses before claude runs, and says what to do.
  reaches = false;
  rmSync(join(home, "node.sock"), { force: true });
  const refused = await start("s-off").then(
    () => "started",
    (e: Error) => e.message,
  );
  expect(refused).toContain("the box can't reach Claude at 100.104.249.49:8317");
  expect(refused).toContain(`(the endpoint from ${join(cfg, "settings.json")})`);
  expect(refused).toContain("Connect Tailscale in Settings › Hub › Machines");
  await placeAt(join(home, "hosts", "s-off")).stop(join(home, "hosts", "s-off"));
  // With it on, a new box is told so before its repo comes in (a stand-in box beside its node refuses the TUN: it
  // carries on without it, and says so), and an endpoint it still can't reach is the tailnet's to fix.
  const t = new NodeTailnet("http://127.0.0.1:1", "devbox", { signTailnet: () => "sig" });
  t.set({ suffix: "tail1234.ts.net" });
  setNodeTailnet(t);
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => void warned.push(String(m));
  try {
    rmSync(join(home, "node.sock"), { force: true });
    const still = await start("s-on").then(
      () => "started",
      (e: Error) => e.message,
    );
    expect(still).toContain("the team's tailnet doesn't reach it either");
    // Refused here by sudo, or on a machine with sudo by the scripts' own guard: never applied to this machine.
    expect(warned.some((w) => w.includes("the team's tailnet isn't in a session's box") && w.includes("the tailnet's device couldn't be set up in the box"))).toBe(true);
  } finally {
    console.warn = warn;
    setNodeTailnet(undefined);
  }
  await placeAt(join(home, "hosts", "s-on")).stop(join(home, "hosts", "s-on"));
}, 60_000);

test("a box that doesn't come up sets its provider aside, and the next start there is refused without another box", async () => {
  const { s, home, env, boxes } = await setup();
  // The repo doesn't clone in the box (here: no repo at all), which is no fault of the provider's.
  const cwd = join(home, "worktrees", "not-a-repo");
  mkdirSync(cwd, { recursive: true });
  const start = (id: string) =>
    hostedPlace("e2b", id, join(home, "hosts", id)).start({ fleetd: [], dir: join(home, "hosts", id), sessionId: id, program: "claude", args: [], cwd, env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: "tok-123" } });
  const made = () => s.calls.filter((c) => c.method === "POST" && c.path === "/v2/sandboxes").length;
  const first = await start("s-down1").catch((e: Error) => e);
  expect(first).toBeInstanceOf(HostedDown);
  expect((first as Error).message).toContain("no hosted sandbox came up at E2B: ");
  // The box it made went, and so did its record; the provider is out of what the heartbeat offers the slot board.
  expect(s.boxes.size).toBe(0);
  expect(readRecord(join(home, "hosts", "s-down1"))).toBeUndefined();
  expect(boxes.usable()).toEqual([]);
  expect(made()).toBe(1);
  // Another session's start (the hub placed it before the heartbeat said so) is refused at once, asking for no box.
  const second = await start("s-down2").catch((e: Error) => e);
  expect(second).toBeInstanceOf(HostedDown);
  expect((second as Error).message).toContain("left out for a few minutes");
  expect(made()).toBe(1);
  // So is setup's command, which doesn't run.
  const ran = await hostedPlace("e2b", "s-down3", join(home, "hosts", "s-down3")).run({ cwd, argv: ["true"], timeoutSec: 30, env, scrub: [] });
  expect(ran.notRun).toContain("left out for a few minutes");
  expect(made()).toBe(1);
}, 60_000);
