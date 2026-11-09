// A node restart for an update, run on the real CLI (crates/fleetd/tests/node_restart.rs): `fleetd node run` exits
// right after its own shutdown, with no fixed grace on top, which was most of the node's blackout. The node's hub is
// unreachable throughout: stopping needs none. That the next start re-adopts a hosted session that ran on meanwhile is
// sessions.test.ts's.
import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "../helpers.ts";

setDefaultTimeout(90_000);

const MAIN = join(import.meta.dir, "../../src/main.ts");

/** `fleetd node run` on `root`'s node home, and a wait for a line of its log with each of `words`. */
function node(root: string) {
  const child = Bun.spawn([process.execPath, MAIN, "node", "run", "--home", join(root, "node")], {
    env: { ...process.env, HOME: join(root, "user"), FLEETD_HOME: join(root, "fleet"), FLEETD_LOG: undefined, CLAUDE_CONFIG_DIR: undefined },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const seen: string[] = [];
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  const said = async (words: string[]) => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const lines = buffered.split("\n");
      buffered = lines.pop()!;
      for (const line of lines) {
        if (words.every((w) => line.includes(w))) return;
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

/** SIGTERMs the node and waits for it to exit: it stops gracefully, in under a second. */
async function stop(child: ReturnType<typeof node>["child"]) {
  const stopping = performance.now();
  child.kill("SIGTERM");
  const code = await child.exited;
  const took = performance.now() - stopping;
  expect(code).toBe(0);
  expect(took).toBeLessThan(1000);
}

test("a node exits at once on SIGTERM, and starts again on the same home", async () => {
  const home = tempHome();
  const root = home.dir;
  for (const sub of ["user", "node"]) mkdirSync(join(root, sub), { recursive: true });
  writeFileSync(
    join(root, "node/node.json"),
    `${JSON.stringify({ hub: "http://127.0.0.1:1", machineId: "m-restart", name: "devbox", tags: [], enrolled: true })}\n`,
  );
  const running: ReturnType<typeof node>["child"][] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const n = node(root);
      running.push(n.child);
      // Its first try to link (the hub is unreachable) comes after it listens for SIGTERM.
      await n.said(["hub link lost"]);
      await stop(n.child);
    }
  } finally {
    for (const child of running) child.kill("SIGKILL");
    home.done();
  }
});

test("a SIGTERM while the node starts up stops it once it is up, rather than killing it", async () => {
  const home = tempHome();
  const root = home.dir;
  for (const sub of ["user", "node"]) mkdirSync(join(root, sub), { recursive: true });
  writeFileSync(
    join(root, "node/node.json"),
    `${JSON.stringify({ hub: "http://127.0.0.1:1", machineId: "m-restart", name: "devbox", tags: [], enrolled: true })}\n`,
  );
  const n = node(root);
  try {
    // Logged as it starts, before its sessions, lead socket and link are up.
    await n.said(["fleetd node starting"]);
    n.child.kill("SIGTERM");
    expect(await n.child.exited).toBe(0);
    expect(n.child.signalCode).toBeNull();
  } finally {
    n.child.kill("SIGKILL");
    home.done();
  }
});
