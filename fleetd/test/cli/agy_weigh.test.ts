// `fleetd agy-weigh` from the CLI: a session's mcp.json on stdin, the servers an Antigravity lead goes without as one
// line on stdout (src/node/agy_budget.ts), for fleetd cloud's lead box. Against a stand-in stdio server with many tools,
// and one that fails printing its key: the key never reaches stdout or stderr.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-agy-weigh-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const main = join(import.meta.dir, "../../src/main.ts");
const KEY = "made-up-key-81c3e0";

async function run(input: string, args: string[] = []) {
  const proc = Bun.spawn([process.execPath, main, "agy-weigh", ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, FLEETD_HOME: join(dir, ".fleetd"), FLEETD_HUB_URL: "http://127.0.0.1:1" },
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

const many = (n: number, pad: number) => ({
  type: "stdio",
  command: process.execPath,
  args: [join(import.meta.dir, "../node/fake-mcp-tools.ts")],
  env: { TOOLS_N: String(n), TOOLS_PAD: String(pad), TOKEN: KEY },
});

test("it names the servers a lead on Antigravity goes without, the biggest, and never a key", async () => {
  const failing = join(dir, "failing-mcp");
  writeFileSync(failing, `#!/bin/sh\necho "bad token: $TOKEN" >&2\nexit 2\n`);
  const servers = { paper: many(50, 1000), notes: many(2, 10), broken: { type: "stdio", command: "sh", args: [failing], env: { TOKEN: KEY } }, fleetd: { type: "stdio", command: "fleetd" } };
  const r = await run(JSON.stringify({ mcpServers: servers }));
  expect([r.code, r.stderr, r.stdout]).toEqual([0, "", '{"left":["paper"]}\n']);
  const light = await run(JSON.stringify({ mcpServers: { notes: many(2, 10) } }));
  expect([light.code, light.stdout]).toEqual([0, '{"left":[]}\n']);
});

test("bad input exits 2 naming the field, never its value", async () => {
  expect(await run("nope")).toEqual({ code: 2, stdout: "", stderr: "fleetd agy-weigh: stdin isn't JSON: usage: fleetd agy-weigh < mcp.json\n" });
  expect(await run(JSON.stringify({ servers: KEY }))).toEqual({ code: 2, stdout: "", stderr: "fleetd agy-weigh: mcpServers isn't an object\n" });
  expect((await run("{}", ["--x"])).code).toBe(2);
});
