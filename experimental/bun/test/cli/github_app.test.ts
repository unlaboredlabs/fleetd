// `fleetd github-app create`'s loopback page: it posts the App's manifest to GitHub, and its landing refuses a state
// or code that isn't the run's. GitHub itself is never reached: the run is stopped before a code comes back.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

test("the manifest page and its landing", async () => {
  const home = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-ghapp-"));
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port;
  await probe.stop(true);
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../../src/main.ts"), "github-app", "create", "--port", String(port), "--name", "fleetd on devbox"], {
    env: { ...process.env, FLEETD_HOME: home, HOME: home, PATH: "/usr/bin:/bin", DISPLAY: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    let page = "";
    // A fresh process on a loaded machine (CI) may take a while to listen.
    for (const until = Date.now() + 20_000; Date.now() < until && page === ""; ) {
      page = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text(), () => "");
      if (page === "") await Bun.sleep(50);
    }
    expect(page).toContain('action="https://github.com/settings/apps/new?state=s_');
    const manifest = JSON.parse(/name="manifest" value="([^"]*)"/.exec(page)![1]!.replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
    expect(manifest.name).toBe("fleetd on devbox");
    expect(manifest.redirect_url).toBe(`http://127.0.0.1:${port}/created`);
    expect(await (await fetch(`http://127.0.0.1:${port}/created?state=nope&code=abc`)).text()).toContain("This isn't fleetd's page");
    const state = /state=(s_[a-z2-7]+)/.exec(page)![1]!;
    expect(await (await fetch(`http://127.0.0.1:${port}/created?state=${state}`)).text()).toContain("No App was created");
  } finally {
    proc.kill();
    await proc.exited;
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
