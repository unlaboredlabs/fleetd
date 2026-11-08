// The compiled binary end to end: `fleetd version`, then `fleetd hub start` on a fresh home and a free port, its
// /healthz, its read worker, and a clean exit on SIGTERM. Run after `bun run compile`.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const bin = join(import.meta.dir, "../dist/fleetd");
const home = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-bun-smoke-"));
const fail = (why: string): never => {
  console.error(`smoke: ${why}`);
  process.exit(1);
};

try {
  const version = Bun.spawnSync([bin, "version"], { cwd: home, env: { ...process.env, FLEETD_HOME: home } });
  if (!/^fleetd \S+ \(protocol \d+\)\n$/.test(version.stdout.toString())) {
    fail(`version said ${version.stdout} (exit ${version.exitCode ?? version.signalCode}): ${version.stderr}`);
  }

  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port;
  await probe.stop(true);
  const started = performance.now();
  const hub = Bun.spawn([bin, "hub", "start", "--home", join(home, "hub"), "--listen", `127.0.0.1:${port}`], {
    // Not this directory: a worker missing from the binary would load from the source tree here.
    cwd: home,
    env: { ...process.env, FLEETD_HOME: home },
    stderr: "pipe",
  });
  let health: unknown;
  for (let i = 0; i < 100 && health === undefined; i++) {
    health = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json(), () => undefined);
    if (health === undefined) await Bun.sleep(50);
  }
  if (!health) fail("no /healthz within 5 s");
  const ready = performance.now() - started;
  await Bun.sleep(200);
  hub.kill("SIGTERM");
  const code = await hub.exited;
  const stderr = await new Response(hub.stderr).text();
  if (code !== 0) fail(`hub start exited ${code}: ${stderr}`);
  if (stderr.includes("read worker")) fail(`the read worker failed: ${stderr}`);
  console.log(`smoke: ok; /healthz ${JSON.stringify(health)} ${ready.toFixed(0)} ms after start`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
