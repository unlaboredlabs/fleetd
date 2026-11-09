// `fleetd session-host …` from the CLI: this binary's own host (src/node/runner/host/serve.ts). Its usage, a claude that
// isn't there (a refused registration, which the node reports as a missing binary), and `stop-all`.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-session-host-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const main = join(import.meta.dir, "../../src/main.ts");

/** Runs the CLI's `session-host`; a fresh home, so nothing reaches a real one. */
async function run(args: string[]) {
  const proc = Bun.spawn([process.execPath, main, "session-host", ...args], {
    env: { PATH: "/usr/bin:/bin", HOME: dir, FLEETD_HOME: join(dir, ".fleetd"), FLEETD_HUB_URL: "http://127.0.0.1:1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { pid: proc.pid, stdout, stderr, code };
}

test("without a command it says how it's used and exits 2, as the Rust host did", async () => {
  const r = await run([]);
  expect([r.code, r.stderr]).toEqual([2, "usage: fleetd session-host <dir> <session id> -- <program> <args…>\n"]);
  expect((await run(["/x", "--", "claude"])).code).toBe(2);
});

test("a claude that isn't there is refused in the registration, as missing", async () => {
  const host = join(dir, "hosts", "s1");
  mkdirSync(host, { recursive: true });
  const r = await run([host, "s1", "--", join(dir, "no-claude")]);
  expect(r.code).toBe(1);
  const registration = JSON.parse(readFileSync(join(host, "host.json"), "utf8"));
  expect(registration).toMatchObject({ protocol: 1, hostPid: r.pid, pid: 0, start: null, refused: { message: "No such file or directory (os error 2)", missing: true } });
  expect(registration.marker).toStartWith("s1.");
});

test("stop-all stops every host in a dir, and says how many ran", async () => {
  const r = await run(["stop-all", join(dir, "none")]);
  expect([r.code, r.stdout]).toEqual([0, "stopped 0 agent session(s)\n"]);
});
