// The hosted place (src/node/place/hosted.ts) end to end against boat.dev's stand-in server, its box running here as the
// provider would run it: setup's command boots the box and runs in it, the session host starts there with a stand-in
// claude and its lines come over the box's link, a node that lets go re-adopts it, a session on the machine's own
// login is refused, the session's ports reach the machine though setup made the box, Claude's endpoint is the box's
// to reach (the team's tailnet, never a relay), and stop brings the work back and deletes the box. A box on this machine shares its paths, so
// the worktree's sync is a no-op here (hosted_files.test.ts tests it apart).
import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { connect, createServer } from "node:net";
import { boatStandIn, KEY, localRunner, type StandIn } from "./stand_ins.ts";
import { provider, ProviderError } from "../../src/sandbox/providers/index.ts";
import { Boxes, DOWN_MS, setBoxes } from "../../src/node/sandbox/remote/boxes.ts";
import { BOX_DIR } from "../../src/node/sandbox/remote/bootstrap.ts";
import { BOX_CLAUDE, BoxNotReady, hasBox, HostedDown, hostedBox, hostedPlace, hostedProbe, nobodyPid, readRecord } from "../../src/node/place/hosted.ts";
import { NodeTailnet, setNodeTailnet } from "../../src/node/sandbox/tailnet.ts";
import { pick, placeAt } from "../../src/node/place/index.ts";
import { LeadRelay } from "../../src/node/lead/index.ts";
import { Masker } from "../../src/node/mask.ts";
import { stop as stopHost, type RunnerEvent } from "../../src/node/runner/host.ts";
import { accountSettingsEnv } from "../../src/node/actions/accounts.ts";
import { settingsOverlay } from "../../src/node/sessions/index.ts";
import { notStartedLine } from "../../src/hub/leads/cut_off.ts";

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
  const s = boatStandIn(local.runner);
  server = s;
  local.track(s);
  const boxes = new Boxes(home, "devbox", { open: (b) => b }, {
    provider: (p, auth) => provider(p, auth, { urls: { api: `${s.url}/api/v1`, sandbox: (box, port) => `${s.url}/box/${box}/${port}` }, pollMs: 5 }),
    source: () => ({ sha256: sha(FLEETD), bytes: async () => FLEETD }),
  });
  boxes.setKeys({ boat: Buffer.from(JSON.stringify({ provider: "boat", key: KEY })).toString("base64") });
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
  const place = hostedPlace("boat", "s1", dir);
  const ran = await place.run({ cwd, argv: ["sh", "-c", "echo set up > setup.txt; echo ok"], timeoutSec: 30, env, scrub: [] });
  expect(ran).toMatchObject({ exitCode: 0 });
  expect(readFileSync(join(cwd, "setup.txt"), "utf8")).toBe("set up\n");
  const record = readRecord(dir)!;
  expect(record).toMatchObject({ kind: "hosted", provider: "boat", session: "s1", cwd });
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
  // The node lets go (its restart); the next node re-adopts the session from the record. A box made before the Claude
  // endpoint stopped being relayed (W722) keeps the relay its claude is pointed at: the record a node of then wrote.
  await link.detach();
  expect(s.boxes.size).toBe(1);
  const gateway = createServer((sock) => sock.pipe(sock)).listen(0, "127.0.0.1");
  await new Promise((r) => gateway.once("listening", r));
  const gw = (gateway.address() as { port: number }).port;
  writeFileSync(join(dir, "place.json"), JSON.stringify({ ...readRecord(dir)!, relays: [{ port: gw, to: { host: "127.0.0.1", port: gw } }] }));
  const again = await placeAt(dir).adopt(dir);
  expect(again).toBeDefined();
  expect(again!.pid).toBe(link.pid);
  // In the box (its loopback here is 127.0.0.2), the relay reaches this machine's gateway again.
  const relayed = await new Promise<string>((resolve, reject) => {
    const c = connect({ host: "127.0.0.2", port: gw }, () => c.write("claude"));
    c.once("data", (d) => (resolve(d.toString()), c.end()));
    c.once("error", reject);
  });
  expect(relayed).toBe("claude");
  gateway.close();

  await placeAt(dir).stop(dir);
  expect(s.boxes.size).toBe(0);
  expect(existsSync(dir)).toBe(false);
  // The node's sweep finds nothing of it left.
  await stopHost(dir);
}, 60_000);

test("a bot with no repo starts in a box: its plain folder goes in, and its work comes back at stop", async () => {
  // Its lead's folder is no checkout, and the box's start failed on it: "no hosted sandbox came up at boat.dev: git
  // rev-parse failed: fatal: not a git repository" (W737).
  const { s, home, env } = await setup();
  const cwd = join(home, "projects", "email-client");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "notes.md"), "first\n");
  const dir = join(home, "hosts", "s-plain");
  const place = hostedPlace("boat", "s-plain", dir);
  const link = await place.start({ fleetd: [], dir, sessionId: "s-plain", program: "claude", args: [], cwd, env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: "tok-123" } });
  expect(JSON.stringify(await next(link))).toContain("m1");
  expect(s.boxes.size).toBe(1);
  expect(readRecord(dir)).toMatchObject({ cwd, base: "plain" });
  writeFileSync(join(cwd, "reply.md"), "from the box\n");
  await placeAt(dir).stop(dir);
  expect(s.boxes.size).toBe(0);
  expect(readFileSync(join(cwd, "notes.md"), "utf8")).toBe("first\n");
  expect(readFileSync(join(cwd, "reply.md"), "utf8")).toBe("from the box\n");
});

test("a session whose bot picked boat.dev · 4 vCPU / 8 GB gets a box of exactly that: boat's type of that size", async () => {
  const { s, home, cwd, env } = await setup();
  const dir = join(home, "hosts", "s-big");
  const place = pick({ sessionId: "s-big", dir, role: "worker", account: true, hosted: "boat", size: { cpu: 4, memGb: 8 } });
  expect(place.kind).toBe("hosted");
  expect(await place.run({ cwd, argv: ["true"], timeoutSec: 30, env, scrub: [] })).toMatchObject({ exitCode: 0 });
  const made = s.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/sandboxes" && !String(c.body?.name ?? "").startsWith("fleetd build"));
  expect(made.map((c) => c.body.type)).toEqual(["default"]);
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
    hostedPlace("boat", id, join(home, "hosts", id)).start({
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
  // Unreached with the team's tailnet off: the start refuses before claude runs, and says what to do, in a person's
  // words: the account, not the settings file it came from, nor the check's own output.
  reaches = false;
  rmSync(join(home, "node.sock"), { force: true });
  const failure = await start("s-off").then(
    () => undefined,
    (e: Error) => e,
  );
  expect(failure).toBeInstanceOf(BoxNotReady);
  const refused = failure!.message;
  expect(refused).toContain("a boat.dev sandbox couldn't reach the hub's Claude account at 100.104.249.49");
  expect(refused).not.toContain("settings.json");
  expect(refused).not.toContain("curl");
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

test("a start that fails once its box exists deletes the box and its record, and the task hears why in plain words", async () => {
  const { s, home, cwd, env, boxes } = await setup();
  const dir = join(home, "hosts", "s-unreached");
  const place = hostedPlace("boat", "s-unreached", dir);
  // Setup made the box, as it does before a session's start.
  expect(await place.run({ cwd, argv: ["true"], timeoutSec: 30, env, scrub: [] })).toMatchObject({ exitCode: 0 });
  expect(s.boxes.size).toBe(1);
  const id = readRecord(dir)!.boxId;
  hostedProbe.probe = async () => {
    throw new Error("the box can't reach Claude at localhost:8317: curl: (7) Failed to connect");
  };
  const failed = await place.start({ fleetd: [], dir, sessionId: "s-unreached", program: "claude", args: [], cwd, env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: "tok-123" } }).catch((e: Error) => e);
  expect(failed).toBeInstanceOf(BoxNotReady);
  expect((failed as Error).message).toContain("a boat.dev sandbox couldn't reach the hub's Claude account at ");
  expect((failed as Error).message).not.toContain("curl");
  // Claude never started: it fails as a box that didn't come up, so a lead's chat says why and its message is kept;
  // and the box came up, so the provider isn't set aside.
  expect(failed).toBeInstanceOf(HostedDown);
  expect(boxes.usable()).toContain("boat");
  // The line the lead's chat shows for it, from the node's own failure text (sessions/index.ts).
  const line = notStartedLine(`could not start ${env.HOME}/.local/bin/claude: ${(failed as Error).message} (cwd ${cwd})`, 1);
  expect(line).toStartWith("The lead couldn't start: a boat.dev sandbox couldn't reach the hub's Claude account at ");
  expect(line).toEndWith("It tries again by itself in about 10 minutes, and your message is kept for it.");
  expect(line).not.toContain(home);
  // The box is deleted once, nothing keeps it alive here, and no record is left for the reaper to spare it by.
  expect(s.calls.filter((c) => c.method === "DELETE" && c.path === `/api/v1/sandboxes/${id}`).length).toBe(1);
  expect(s.boxes.size).toBe(0);
  expect(hasBox("s-unreached")).toBe(false);
  expect(hostedBox("s-unreached")).toBeUndefined();
  expect(existsSync(join(dir, "place.json"))).toBe(false);
}, 60_000);

test("a start whose Claude Code isn't in the box says so, and a box no session ran in brings nothing back (W756)", async () => {
  const { s, home, cwd, env } = await setup();
  const dir = join(home, "hosts", "s-noclaude");
  // The template has no Claude Code where the start runs it (fleetd-94251c014f62 on 2026-11-20).
  BOX_CLAUDE.path = join(tmp, "no-such-claude");
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void warned.push(a.map(String).join(" "));
  try {
    const failed = await hostedPlace("boat", "s-noclaude", dir).start({ fleetd: [], dir, sessionId: "s-noclaude", program: "claude", args: [], cwd, env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: "tok-123" } }).catch((e: Error) => e);
    expect(failed).toBeInstanceOf(BoxNotReady);
    expect((failed as Error).message).toBe("its boat.dev sandbox came up, but fleetd didn't start in it");
  } finally {
    console.warn = warn;
  }
  expect(warned.some((w) => w.includes("fleetd's session host didn't come up in a hosted box"))).toBe(true);
  // Nothing was taken back from a box no session ran in: no second, misleading error, and no sync ref in the repo.
  expect(warned.filter((w) => w.includes("work didn't come back"))).toEqual([]);
  expect(sh(cwd, "git for-each-ref refs/fleetd/sync/s-noclaude")).toBe("");
  // A take-back resets the worktree to what the box sent (files.ts syncOut): none did here.
  expect(sh(cwd, "git reflog -n 50 --format=%gs")).not.toContain("fleetd/sync/s-noclaude/out-head");
  expect(s.boxes.size).toBe(0);
  expect(existsSync(join(dir, "place.json"))).toBe(false);
}, 60_000);

test("a box checks the Claude account's endpoint, not the gateway on the machine's loopback its claude settings name", async () => {
  const { home, cwd, env } = await setup();
  const cfg = join(tmp, "cfg-loopback");
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://localhost:8317", ANTHROPIC_AUTH_TOKEN: "machine-gateway-token" } }));
  // The session's settings overlay, as the node writes it for a session on the hub's API key (sessions #spec).
  const overlay = join(tmp, "overlay-account.json");
  writeFileSync(overlay, settingsOverlay(accountSettingsEnv([["ANTHROPIC_API_KEY", "hub-key-0123"], ["ANTHROPIC_BASE_URL", "http://100.104.249.49:8317"]]), {}, "haiku", [], false, false, "true"));
  const checked: string[] = [];
  hostedProbe.probe = async (_box, url) => void checked.push(url);
  try {
    const id = "s-account";
    const link = await hostedPlace("boat", id, join(home, "hosts", id)).start({
      fleetd: [],
      dir: join(home, "hosts", id),
      sessionId: id,
      program: "claude",
      args: ["-p", "--settings", overlay],
      cwd,
      env: { ...env, ANTHROPIC_API_KEY: "hub-key-0123", ANTHROPIC_BASE_URL: "http://100.104.249.49:8317", CLAUDE_CONFIG_DIR: cfg, FLEETD_RUNNER_SESSION: `${id}.mark` },
    });
    expect(checked).toEqual(["http://100.104.249.49:8317"]);
    expect(JSON.stringify(await next(link))).toContain("m1");
    await placeAt(join(home, "hosts", id)).stop(join(home, "hosts", id));
  } finally {
    hostedProbe.probe = undefined;
  }
}, 60_000);

test("a template build step that fails says the template didn't build, its output only in the log", async () => {
  const { s, home, cwd, env, boxes } = await setup();
  // The build box's first step exits 2 with its own output, paths and all.
  s.fail({ path: /^GET .*\/commands\/\d+$/, status: 200, body: { ok: true, running: false, exitCode: 2, stderr: `tar: ${home}/x: Cannot open: No such file or directory` } });
  const failed = await hostedPlace("boat", "s-tpl", join(home, "hosts", "s-tpl"))
    .start({ fleetd: [], dir: join(home, "hosts", "s-tpl"), sessionId: "s-tpl", program: "claude", args: [], cwd, env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: "tok-123" } })
    .catch((e: Error) => e);
  expect(failed).toBeInstanceOf(HostedDown);
  expect((failed as Error).message).toStartWith("boat.dev's sandbox template didn't build (try again in a minute); trying again at ");
  expect(boxes.trouble()[0]?.why).toBe("boat.dev's sandbox template didn't build");
}, 60_000);

test("boat.dev refusing a box for billing sets it aside saying so: the heartbeat's trouble and the next start's words", async () => {
  const { s, home, cwd, env, boxes } = await setup();
  // boat.dev answers every create (the template's build box too) with its 402.
  s.fail({ path: /^POST \/api\/v1\/sandboxes$/, status: 402, body: { ok: false, code: "payment_required", message: "Payment required" }, times: 10 });
  const start = (id: string) =>
    hostedPlace("boat", id, join(home, "hosts", id)).start({ fleetd: [], dir: join(home, "hosts", id), sessionId: id, program: "claude", args: [], cwd, env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: "tok-123" } });
  expect(await start("s-bill1").catch((e: Error) => e)).toBeInstanceOf(HostedDown);
  const [trouble] = boxes.trouble();
  expect(trouble).toMatchObject({ provider: "boat", what: "start", reason: "billing", until: expect.any(Number) });
  expect(boxes.trouble()).toHaveLength(1);
  const second = await start("s-bill2").catch((e: Error) => e);
  expect((second as Error).message).toMatch(/^boat\.dev refused: billing isn't set up on the account \(set up billing in boat\.dev's dashboard\); trying again at \d\d:\d\d$/);
  // The hub's fresh word (a key that works again) offers it again at once.
  boxes.retry();
  expect(boxes.trouble()).toEqual([]);
}, 60_000);

test("a keep-alive that fails is reported until one works again", async () => {
  const { boxes } = await setup();
  boxes.keptAlive("boat", new ProviderError("invalid_key", "boat refused the key: it is wrong, expired or revoked (401 Unauthorized)."));
  expect(boxes.trouble()).toEqual([{ provider: "boat", what: "keep_alive", reason: "invalid_key", why: "boat refused the key: it is wrong, expired or revoked (401 Unauthorized)." }]);
  boxes.keptAlive("boat");
  expect(boxes.trouble()).toEqual([]);
});

test("a keep-alive failure goes with Try again or a new key, and a while after the provider's last box went", async () => {
  const { boxes } = await setup();
  const fail = () => boxes.keptAlive("boat", new ProviderError("unreachable", "boat.dev didn't answer"));
  // Try again: the hub's fresh word reaches the node as its limits, which ask every provider again.
  fail();
  boxes.retry();
  expect(boxes.trouble()).toEqual([]);
  // A new key (or none): the failure was the old key's.
  fail();
  boxes.setKeys({ boat: Buffer.from(KEY).toString("base64") });
  expect(boxes.trouble()).toEqual([]);
  // Its failed keep-alive ended the provider's last box: still said for DOWN_MS, so the row and leads hear of it, then
  // gone, with no box left to keep.
  fail();
  const at = Date.now();
  boxes.noneLive("boat", at);
  expect(boxes.trouble(at + 1000)).toHaveLength(1);
  expect(boxes.trouble(at + DOWN_MS + 1)).toEqual([]);
});

test("one bot's own failure (its files didn't go in) fails its start alone: the provider stays offered, and another bot's box comes up", async () => {
  // W756 W5: before, a bot whose repo or files didn't go in set boat.dev aside for 10 minutes for every bot of the team.
  const { s, home, cwd, env, boxes } = await setup();
  const start = (id: string, at: string) =>
    hostedPlace("boat", id, join(home, "hosts", id)).start({ fleetd: [], dir: join(home, "hosts", id), sessionId: id, program: "claude", args: [], cwd: at, env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: "tok-123" } });
  const made = () => s.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/sandboxes" && !String(c.body?.name ?? "").startsWith("fleetd build")).length;
  // The worktree doesn't go into the box (here: it isn't there at all), which is no fault of the provider's.
  const first = await start("s-own1", join(home, "worktrees", "gone")).catch((e: Error) => e);
  // It fails as a box that came up where the session couldn't start: a lead's chat says why and its message is kept.
  expect(first).toBeInstanceOf(BoxNotReady);
  // In plain words: what didn't work, never the tar's output or the machine's paths (the log keeps those), nor a time.
  expect((first as Error).message).toBe("its boat.dev sandbox came up, but it couldn't get the bot's files");
  expect((first as Error).message).not.toContain(home);
  expect(notStartedLine(`could not start ${env.HOME}/.local/bin/claude: ${(first as Error).message} (cwd ${cwd})`, 1)).toBe(
    "The lead couldn't start: its boat.dev sandbox came up, but it couldn't get the bot's files. It tries again by itself in about 10 minutes, and your message is kept for it.",
  );
  // The box it made went, and so did its record; the provider is still offered, with no trouble on its row.
  expect(s.boxes.size).toBe(0);
  expect(readRecord(join(home, "hosts", "s-own1"))).toBeUndefined();
  expect(boxes.trouble()).toEqual([]);
  expect(boxes.usable()).toContain("boat");
  expect(made()).toBe(1);
  // Another bot's start makes its own box and comes up. (A box here shares this machine's paths: the first one's
  // forwarded node.sock stays behind, where a real box has its own.)
  rmSync(join(home, "node.sock"), { force: true });
  await start("s-own2", cwd);
  expect(made()).toBe(2);
  expect(hasBox("s-own2")).toBe(true);
  await placeAt(join(home, "hosts", "s-own2")).stop(join(home, "hosts", "s-own2"));
}, 60_000);

test("a provider's own refusal sets it aside, and the next start there is refused without another box", async () => {
  const { s, home, cwd, env, boxes } = await setup();
  // boat.dev doesn't answer creates (its API is down): its own failure, not a bot's.
  s.fail({ path: /^POST \/api\/v1\/sandboxes$/, status: 503, body: { ok: false, code: "unavailable", message: "Service unavailable" }, times: 10 });
  const start = (id: string) =>
    hostedPlace("boat", id, join(home, "hosts", id)).start({ fleetd: [], dir: join(home, "hosts", id), sessionId: id, program: "claude", args: [], cwd, env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: "tok-123" } });
  const asked = () => s.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/sandboxes").length;
  const first = await start("s-down1").catch((e: Error) => e);
  expect(first).toBeInstanceOf(HostedDown);
  expect(first).not.toBeInstanceOf(BoxNotReady);
  expect(boxes.trouble()).toMatchObject([{ provider: "boat", what: "start" }]);
  expect(boxes.usable()).toEqual([]);
  const before = asked();
  // Another session's start (the hub placed it before the heartbeat said so) is refused at once, asking for no box.
  const second = await start("s-down2").catch((e: Error) => e);
  expect(second).toBeInstanceOf(HostedDown);
  expect((second as Error).message).toMatch(/; trying again at \d\d:\d\d$/);
  expect(asked()).toBe(before);
  // So is setup's command, which doesn't run.
  const ran = await hostedPlace("boat", "s-down3", join(home, "hosts", "s-down3")).run({ cwd, argv: ["true"], timeoutSec: 30, env, scrub: [] });
  expect(ran.notRun).toMatch(/trying again at/);
  expect(asked()).toBe(before);
}, 60_000);
