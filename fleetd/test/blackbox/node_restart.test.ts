// A node restart for an update, run on the binary: `fleetd node run` exits right after its own shutdown (no fixed
// grace on top, which was most of the node's blackout), and the next one re-adopts the hosted session that ran on
// meanwhile, its host the binary's own `fleetd session-host`. The node's hub is unreachable throughout: neither needs
// it.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostAlive, killTree, launch, marker, type Registration } from "../../src/node/runner/host.ts";
import { NodeStore } from "../../src/node/sessions/store.ts";
import { tempHome } from "../helpers.ts";
import { BIN, cleanEnv, run, script } from "./kit.ts";

setDefaultTimeout(90_000);

/** Answers `--version`; as a session, says it started, then runs until its stdin closes. */
const CLAUDE = `if [ "$1" = "--version" ]; then echo "2.1.302 (Claude Code)"; exit 0; fi
echo '{"type":"system","subtype":"init","claude_code_version":"2.1.302","model":"fake","cwd":"/fake","tools":["Bash","Read"]}'
exec cat > /dev/null
`;

const SESSION = "node-restart-1";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const done of cleanups.splice(0).reverse()) await done();
});

function machine() {
  const home = tempHome();
  cleanups.push(home.done);
  const root = home.dir;
  for (const sub of ["user", "bin", "work", "node"]) mkdirSync(join(root, sub));
  script(join(root, "bin/claude"), CLAUDE);
  writeFileSync(join(root, "node/node.json"), '{"hub":"http://127.0.0.1:1","machineId":"m-restart","name":"devbox","tags":[],"enrolled":true}');
  const path = `${join(root, "bin")}:${process.env.PATH ?? ""}`;
  const env = cleanEnv({ HOME: join(root, "user"), PATH: path, FLEETD_HOME: join(root, "fleet") });
  return { root, home: join(root, "node"), env };
}

/** A session the node hosts, as a node that stopped left it: its claude running under the binary's host, and its row. */
async function hostedSession(m: ReturnType<typeof machine>): Promise<Registration> {
  const hosts = join(m.home, "hosts");
  const work = join(m.root, "work");
  const link = await launch({
    fleetd: [BIN!],
    dir: join(hosts, SESSION),
    sessionId: SESSION,
    program: join(m.root, "bin/claude"),
    args: [],
    cwd: work,
    env: { ...m.env, FLEETD_RUNNER_SESSION: marker(SESSION) },
  });
  const registration = link.registration;
  // Only this host and its claude, which the test started: the host's own stop, then whatever outlived it.
  cleanups.push(async () => {
    await run([BIN!, "session-host", "stop-all", hosts], m.env);
    killTree(registration);
  });
  // Nothing here applies its events: it lets go of the host at once, as a node shutting down does.
  link.applied = Number.MAX_SAFE_INTEGER;
  await link.detach();

  const store = new NodeStore(join(m.home, "sessions.sqlite"));
  store.upsertProject({ projectId: "p1", title: "p1", workspaceRoot: work, updatedAt: "2026-11-08T00:00:00Z" } as never);
  const summary = {
    sessionId: SESSION,
    projectId: "p1",
    title: "restart",
    status: "idle",
    model: "claude-haiku-5-5",
    effort: "low",
    runtimeMode: "full-access",
    createdAt: "2026-11-08T00:00:00Z",
    updatedAt: "2026-11-08T00:00:00Z",
  };
  const local = { cwd: work, addDirs: [], configDir: join(m.root, "user/.claude"), workspaceRoot: work, started: true, pid: registration.pid };
  store.commit({ summary, local } as never, [], false);
  store.close();
  return registration;
}

/** `fleetd node run` on the machine's home, and a wait for a line of its log with each of `words`. */
function node(m: ReturnType<typeof machine>) {
  const child = Bun.spawn([BIN!, "node", "run", "--home", m.home], { env: m.env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  // Kills the node if an assertion fails while it runs, so no test leaves one behind.
  cleanups.push(() => void child.kill("SIGKILL"));
  const seen: string[] = [];
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  const said = async (words: string[]) => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const lines = buffered.split("\n");
      buffered = lines.pop()!;
      for (const [i, line] of lines.entries()) {
        if (words.every((w) => line.includes(w))) {
          buffered = [...lines.slice(i + 1), buffered].join("\n");
          return;
        }
        seen.push(line);
      }
      const left = deadline - Date.now();
      const next = left > 0 ? await Promise.race([reader.read(), Bun.sleep(left).then(() => undefined)]) : undefined;
      if (!next || next.done) throw new Error(`the node never said ${JSON.stringify(words)}; it said:\n${seen.join("\n")}`);
      buffered += next.value;
    }
  };
  return { child, said };
}

/** The node re-adopted the session, then is up: its first try to link (the hub is unreachable) comes after it listens
 * for SIGTERM. */
async function upWithTheSession(n: ReturnType<typeof node>) {
  await n.said(["re-adopted a session", SESSION]);
  await n.said(["hub link lost"]);
}

/** SIGTERMs the node and waits for it to exit: it stops gracefully, in under a second. */
async function stop(child: ReturnType<typeof node>["child"]) {
  const stopping = performance.now();
  child.kill("SIGTERM");
  const code = await child.exited;
  const took = performance.now() - stopping;
  expect(child.signalCode).toBeNull();
  expect(code).toBe(0);
  expect(took, `the node took ${took} ms to exit`).toBeLessThan(1000);
}

test.skipIf(!BIN || process.platform !== "linux")("a node exits at once on SIGTERM, and its next start re-adopts the session", async () => {
  const m = machine();
  const registration = await hostedSession(m);
  expect(hostAlive(registration)).toBe(true);

  const first = node(m);
  await upWithTheSession(first);
  await stop(first.child);
  expect(hostAlive(registration), "the session ran on without its node").toBe(true);

  const second = node(m);
  await upWithTheSession(second);
  await stop(second.child);
  expect(hostAlive(registration)).toBe(true);
});

test.skipIf(!BIN || process.platform !== "linux")("a SIGTERM while the node starts up stops it once it is up, rather than killing it", async () => {
  const m = machine();
  const n = node(m);
  // Logged as it starts, before its sessions and link are up.
  await n.said(["fleetd node starting"]);
  n.child.kill("SIGTERM");
  expect(await n.child.exited).toBe(0);
  expect(n.child.signalCode).toBeNull();
});
