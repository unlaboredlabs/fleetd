// How a hosted box reaches Claude (src/node/place/endpoint.ts): the endpoint claude itself picks, from its environment
// and each settings file in claude's own order; the box's check of it, and what to do when it fails (connect Tailscale
// for a private endpoint).
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunOutcome } from "../../src/node/cmd/index.ts";
import { ANTHROPIC_API, claudeEndpoint, fromProject, privateByName, probe, probeArgv, publicEndpoint, publicIp, unreached } from "../../src/node/place/endpoint.ts";
import type { Box } from "../../src/node/sandbox/box.ts";

const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-endpoint-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const settings = (file: string, url: string) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: url } }));
};

test("the endpoint is the one claude picks: its environment, then each settings file in claude's order", () => {
  const cfg = join(root, "cfg");
  const cwd = join(root, "wt");
  mkdirSync(cwd, { recursive: true });
  const l = { env: { CLAUDE_CONFIG_DIR: cfg } as Record<string, string>, args: [] as string[], cwd };
  expect(claudeEndpoint(l)).toEqual({ url: ANTHROPIC_API, source: "Anthropic's API, the default" });
  l.env.ANTHROPIC_BASE_URL = "http://localhost:1";
  expect(claudeEndpoint(l)).toEqual({ url: "http://localhost:1", source: "the environment" });
  // The user's settings win over the environment: the devbox's gateway is set only there.
  settings(join(cfg, "settings.json"), "http://localhost:8317");
  expect(claudeEndpoint(l)).toEqual({ url: "http://localhost:8317", source: join(cfg, "settings.json") });
  expect(fromProject(claudeEndpoint(l), cwd)).toBe(false);
  settings(join(cwd, ".claude", "settings.json"), "http://project:2");
  expect(claudeEndpoint(l).url).toBe("http://project:2");
  settings(join(cwd, ".claude", "settings.local.json"), "http://local:3");
  expect(claudeEndpoint(l).url).toBe("http://local:3");
  // Set by the project's own files: a failure to reach it is that project's.
  expect(fromProject(claudeEndpoint(l), cwd)).toBe(true);
  const overlay = join(root, "overlay.json");
  writeFileSync(overlay, JSON.stringify({ env: { OTHER: "x" } }));
  l.args = ["--settings", overlay];
  expect(claudeEndpoint(l).url).toBe("http://local:3");
  l.args = ["--settings", overlay, "--settings", JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://inline:4" } })];
  expect(claudeEndpoint(l)).toEqual({ url: "https://inline:4", source: "--settings" });
});

test("an endpoint is public by its addresses: a tailnet, LAN or loopback one isn't", async () => {
  for (const ip of ["10.1.2.3", "172.16.0.1", "192.168.2.254", "100.64.0.10", "100.127.255.1", "127.0.0.1", "169.254.1.1", "::1", "fd7a:115c:a1e0::1", "fe80::1", "::ffff:10.0.0.1"]) expect(publicIp(ip)).toBe(false);
  for (const ip of ["160.79.104.10", "100.63.0.1", "172.32.0.1", "2607:6bc0::10", "::ffff:8.8.8.8"]) expect(publicIp(ip)).toBe(true);
  const dns = (map: Record<string, string[]>) => async (h: string) => map[h] ?? Promise.reject(new Error("ENOTFOUND"));
  const resolve = dns({ "api.anthropic.com": ["160.79.104.10", "2607:6bc0::10"], "gw.corp.example": ["10.0.0.5"], "mixed.example": ["160.79.104.10", "10.0.0.5"] });
  expect(await publicEndpoint(ANTHROPIC_API, resolve)).toBe(true);
  expect(await publicEndpoint("https://gw.corp.example", resolve)).toBe(false);
  expect(await publicEndpoint("https://mixed.example", resolve)).toBe(false);
  expect(await publicEndpoint("https://unknown.example", resolve)).toBe(false);
  expect(await publicEndpoint("https://gateway.tail1234.ts.net", resolve)).toBe(false);
  expect(await publicEndpoint("http://devbox:8317", resolve)).toBe(false);
  expect(await publicEndpoint("http://localhost:8317", resolve)).toBe(false);
  expect(await publicEndpoint("http://100.64.0.10:8317", resolve)).toBe(false);
  expect(await publicEndpoint("https://160.79.104.10", resolve)).toBe(true);
});

test("a hosted box is only checked, and a failed check says what to do: connect Tailscale for a private endpoint", async () => {
  const ok: RunOutcome = { exitCode: 0, outputTail: "", timedOut: false };
  const box = fakeBox([ok, { exitCode: 7, outputTail: "curl: (7) Failed to connect to 100.104.249.49 port 8317\n", timedOut: false }]);
  await probe(box.box, "http://100.104.249.49:8317");
  expect(box.runs).toEqual([probeArgv("http://100.104.249.49:8317")]);
  await expect(probe(box.box, "http://100.104.249.49:8317")).rejects.toThrow("the box can't reach Claude at 100.104.249.49:8317: curl: (7) Failed to connect");
  const dns = async (h: string) => (h === "api.anthropic.com" ? ["160.79.104.10"] : Promise.reject(new Error("ENOTFOUND")));
  const e = (url: string) => ({ url, source: "the environment" });
  const off = await unreached(e("http://100.104.249.49:8317"), "boat.dev", false, dns);
  // In a person's words: the account, never the check's output or the file the endpoint was set in.
  expect(off).toBe("a boat.dev sandbox couldn't reach the hub's Claude account at 100.104.249.49: it is on a private network, which hosted sandboxes reach only on the team's tailnet. Connect Tailscale in Connections");
  expect(await unreached(e("http://devbox.tail1234.ts.net:8317"), "boat.dev", true, dns)).toContain("the team's tailnet doesn't reach it either");
  expect(await unreached(e("http://localhost:8317"), "boat.dev", false, dns)).toContain("a machine's own loopback, which a hosted sandbox never reaches");
  // A public endpoint's failure is its own: nothing to connect.
  expect(await unreached(e(ANTHROPIC_API), "boat.dev", false, dns)).toBe("a boat.dev sandbox couldn't reach the hub's Claude account at api.anthropic.com: it didn't answer from there. Check that it is up, then try again");
  // By its name or address alone, for the runner's word.
  for (const u of ["http://100.104.249.49:8317", "http://devbox:8317", "https://gw.tail1234.ts.net", "http://localhost:1", "http://10.0.0.5"]) expect(privateByName(u)).toBe(true);
  for (const u of [ANTHROPIC_API, "https://gw.example.com", "https://160.79.104.10"]) expect(privateByName(u)).toBe(false);
});

test("the hub's runner says to connect Tailscale while its Claude endpoint is plainly private and the tailnet is off", async () => {
  const { runnerClaude } = await import("../../src/node/sessions/index.ts");
  const hub = { kind: "hub" } as const;
  expect(runnerClaude(hub, "http://100.104.249.49:8317").problem).toBe(
    "the hub's Claude endpoint http://100.104.249.49:8317 is on a private network, which hosted sandboxes reach only on the team's tailnet. Fix: connect Tailscale in Connections",
  );
  expect(runnerClaude(hub, "http://100.104.249.49:8317", true).problem).toBeUndefined();
  expect(runnerClaude(hub, ANTHROPIC_API).problem).toBeUndefined();
  expect(runnerClaude(hub).login).toBe("logged_in");
  expect(runnerClaude(undefined).problem).toContain("none reaches them");
});

/** A box whose commands answer `outcomes` in turn, and that keeps what it ran. */
function fakeBox(outcomes: RunOutcome[]) {
  const runs: string[][] = [];
  const box = { run: async (r: { argv: string[] }) => (runs.push(r.argv), outcomes.shift()!) } as unknown as Box;
  return { box, runs };
}
