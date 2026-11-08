// The node updating itself to its hub's build: fetched ahead and checked, installed with the running binary kept for a
// rollback, and the restart planned for the watcher; refused where it can't restart itself or runs a local build.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetch, notRestarted, run, stage, type Place } from "../../src/node/update/index.ts";
import type { Feed } from "../../src/update/index.ts";
import type { Plan } from "../../src/update/finish.ts";
import { tempHome } from "../helpers.ts";

const sha = (b: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

function feedOf(version: string, build: string): Feed & { got: string[] } {
  const files: Record<string, string> = {
    "release.json": JSON.stringify({ cliVersion: version }),
    SHA256SUMS: `${sha(build)}  fleetd-linux-x64\n`,
    "fleetd-linux-x64": build,
  };
  const got: string[] = [];
  return {
    got,
    get: async (name) => {
      got.push(name);
      if (!(name in files)) throw new Error(`no ${name}`);
      return new TextEncoder().encode(files[name]);
    },
  };
}

const place = (home: string, over: Partial<Place> = {}): Place => {
  mkdirSync(join(home, "bin"), { recursive: true });
  const exe = join(home, "bin", "fleetd");
  writeFileSync(exe, "old build");
  return { home: join(home, "node"), exe, services: [{ name: "fleetd-node", unit: "node" }], running: "1.0.0", releaseBuild: true, asset: "fleetd-linux-x64", ...over };
};

test("a fetched build is installed by the update that follows, the running one kept, and the restart planned", async () => {
  const home = tempHome();
  try {
    const p = place(home.dir);
    const feed = feedOf("1.1.0", "new build");
    await fetch({ version: "1.1.0", channel: "stable" }, p, feed);
    expect(readFileSync(join(p.home, "update", "fleetd.next"), "utf8")).toBe("new build");
    let planned: Plan | undefined;
    const answer = await run({ version: "1.1.0", channel: "stable" }, p.home, {
      place: p,
      feed: feedOf("9.9.9", "the channel moved on"),
      previous: () => new TextEncoder().encode("old build"),
      startWatcher: (plan) => (planned = plan),
    });
    expect(answer.message).toBe("restarting on 1.1.0");
    expect(readFileSync(p.exe, "utf8")).toBe("new build");
    expect(readFileSync(join(p.home, "update", "fleetd.prev"), "utf8")).toBe("old build");
    expect(planned).toMatchObject({ from: "1.0.0", to: "1.1.0", service: { unit: "node" }, health: { kind: "node" } });
    expect(answer.watch?.verdict).toBe(join(p.home, "update", "node-verdict.json"));
  } finally {
    home.done();
  }
});

test("an update that can't run says why, and changes nothing", async () => {
  const home = tempHome();
  try {
    const why = (p: Promise<unknown>) => p.then(() => "staged", (e: Error) => e.message);
    const feed = feedOf("1.1.0", "new build");
    const previous = () => new Uint8Array();
    expect(await stage({ version: "1.0.0", channel: "stable" }, place(home.dir), feed, previous)).toEqual({ kind: "current" });
    expect(await why(stage({ version: "1.1.0", channel: "stable" }, place(home.dir, { services: [] }), feed, previous))).toContain("can't restart itself");
    expect(await why(stage({ version: "1.1.0", channel: "stable" }, place(home.dir, { releaseBuild: false }), feed, previous))).toContain("runs a local build");
    expect(await why(stage({ version: "1.2.0", channel: "stable" }, place(home.dir), feed, previous))).toBe(
      "the channel's newest build is now 1.1.0, not the hub's 1.2.0: update again",
    );
    expect(readFileSync(place(home.dir).exe, "utf8")).toBe("old build");
    // A verdict the watcher wrote while this node still runs: the restart was refused.
    const verdict = join(home.dir, "verdict.json");
    writeFileSync(verdict, JSON.stringify({ state: "failed", stage: "restart", message: "systemctl refused" }));
    expect((await notRestarted(verdict, 1000))?.message).toBe("systemctl refused");
    expect(await notRestarted(join(home.dir, "none.json"), 300)).toBeUndefined();
  } finally {
    home.done();
  }
});
