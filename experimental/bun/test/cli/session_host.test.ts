// `fleetd session-host …` from the Bun CLI: it becomes the Rust binary's (execve, the same process), found as the node
// finds it (findHelper); without one, the node's own "no session host" error rather than a loop back into itself.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NO_HELPER } from "../../src/node/runner/helper.ts";

const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-session-host-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const main = join(import.meta.dir, "../../src/main.ts");

/** Runs the Bun CLI's `session-host` with `env`; a fresh home, so nothing reaches a real one. */
async function run(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, main, "session-host", ...args], {
    env: { PATH: "/usr/bin:/bin", HOME: dir, FLEETD_HOME: join(dir, ".fleetd"), FLEETD_HUB_URL: "http://127.0.0.1:1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { pid: proc.pid, stdout, stderr, code };
}

function script(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
}

test("it hands the whole command to the session host, in the same process, with its exit code and environment", async () => {
  // Answers as the Rust binary's session-host does with no arguments, so the lookup takes it.
  const native = join(dir, "fleetd-native");
  script(
    native,
    'if [ "$#" -le 1 ]; then echo "usage: fleetd session-host <dir> <session id> -- <program> <args…>" >&2; exit 2; fi\necho "$$ $* ${FLEETD_SESSION_HOST_LOOKUP:-unset} $KEPT"\nexit 7\n',
  );
  const r = await run(["stop-all", "/some/dir"], { FLEETD_NATIVE_BIN: native, KEPT: "kept" });
  expect(r.stderr).toBe("");
  expect(r.code).toBe(7);
  expect(r.stdout).toBe(`${r.pid} session-host stop-all /some/dir unset kept\n`);
});

test("without a session host it says what's missing and exits 1", async () => {
  const r = await run(["stop-all", "/some/dir"], { FLEETD_NATIVE_BIN: join(dir, "missing") });
  expect([r.code, r.stderr]).toEqual([1, `fleetd: ${NO_HELPER}\n`]);
});

test("another Bun build on PATH, itself without a host, is tried and refuses at once instead of trying this one", async () => {
  const bin = join(dir, "other");
  mkdirSync(bin);
  script(join(bin, "fleetd"), `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(main)} "$@"\n`);
  const started = Date.now();
  const r = await run(["stop-all", "/some/dir"], { PATH: `${bin}:/usr/bin:/bin` });
  expect([r.code, r.stderr]).toEqual([1, `fleetd: ${NO_HELPER}\n`]);
  expect(Date.now() - started).toBeLessThan(10_000);
}, 30_000);
