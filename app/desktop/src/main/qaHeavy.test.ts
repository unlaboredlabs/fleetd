// The QA screens start an Electron app per worker, so on an agent's machine every QA run, filtered or not, waits its turn
// for one of the machine's heavy-run slots (scripts/heavy.sh, through fleetd's `fleetd-heavy`), as scripts/check.sh
// does; one inside the check, which holds a slot already, and one where fleetd isn't (CI), run at once.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../..");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

it("pnpm qa and qa:selftest run through scripts/heavy.sh", () => {
  const scripts = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  for (const name of ["qa", "qa:selftest"]) expect(scripts[name]).toMatch(/^sh scripts\/heavy\.sh playwright test /u);
});

it("takes a heavy-run slot where fleetd-heavy is, unless the run holds one already", () => {
  const bin = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "qa-heavy-"));
  dirs.push(bin);
  // A stand-in fleetd-heavy that says it was used, then runs the command as the real one does.
  writeFileSync(join(bin, "fleetd-heavy"), '#!/bin/sh\necho "slot:"\nexec "$@"\n');
  chmodSync(join(bin, "fleetd-heavy"), 0o755);
  const run = (path: string, extra: Record<string, string> = {}) => {
    const env: Record<string, string | undefined> = { ...process.env, PATH: path };
    delete env.FLEETD_HEAVY_SLOT;
    delete env.FLEETD_CHECK_SLOT;
    Object.assign(env, extra);
    return spawnSync("sh", [join(ROOT, "scripts/heavy.sh"), "echo", "ran", "--grep", "a b"], { env, encoding: "utf8" }).stdout;
  };
  expect(run(`${bin}:/usr/bin:/bin`)).toBe("slot:\nran --grep a b\n");
  expect(run(`${bin}:/usr/bin:/bin`, { FLEETD_HEAVY_SLOT: "1" })).toBe("ran --grep a b\n");
  expect(run("/usr/bin:/bin")).toBe("ran --grep a b\n");
});
