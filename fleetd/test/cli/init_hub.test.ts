// `fleetd init --yes` on a hub machine with nothing installed yet: no ip (a Mac, or Linux without iproute2), no git, gh
// or claude. It must end with what needs doing, never a stack trace. A fresh home under $TMPDIR, and --no-service.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { lanIpv4 } from "../../src/cli/setup/detect.ts";

const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-init-hub-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("lanIpv4 is a private IPv4 address or nothing, without running any program", async () => {
  const ip = await lanIpv4();
  if (ip !== undefined) expect(ip).toMatch(/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d+\.\d+/);
});

test("a bare PATH: init lists what needs you and exits 1", async () => {
  const empty = join(dir, "empty");
  mkdirSync(empty);
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../../src/main.ts"), "init", "--yes", "--no-service", "--listen", "127.0.0.1:1"], {
    env: { PATH: empty, HOME: dir, FLEETD_HOME: join(dir, ".fleetd"), FLEETD_HUB_URL: "http://127.0.0.1:1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const said = stdout + stderr;
  expect(said).not.toContain("Executable not found");
  expect(said).toContain('commit author: fleetd init --git-identity "Name <id+user@users.noreply.github.com>"');
  expect(said).toContain("Fix those, then run fleetd init again; it keeps what's done.");
  expect(code).toBe(1);
}, 30_000);
