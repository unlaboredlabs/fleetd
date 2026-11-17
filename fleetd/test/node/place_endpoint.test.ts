// How a box reaches Claude (src/node/place/endpoint.ts): the endpoint claude itself picks, from its environment and
// each settings file in claude's own order, and for every kind of endpoint (this machine's loopback, its LAN or
// tailnet address, another tailnet host by name or IP, http or https, Anthropic's API) the relay, the pin, the port in
// the box (never one under 1024) and the check that make it reachable from inside a box, or (a hosted box, a public
// endpoint) the box's own network.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import type { RunOutcome } from "../../src/node/cmd/index.ts";
import { ANTHROPIC_API, boxArgs, claudeEndpoint, fromProject, loopbackFor, pinScript, probeArgv, publicEndpoint, publicIp, reach, reachOf } from "../../src/node/place/endpoint.ts";
import type { Box, Relay } from "../../src/node/sandbox/box.ts";

const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-endpoint-"));
const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
  rmSync(root, { recursive: true, force: true });
});

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

test("every kind of endpoint gets a relay through the node, its name or IP kept and never a port under 1024 in the box", () => {
  // This machine's loopback: the box's own loopback at the same port, nothing pinned.
  expect(reachOf("http://localhost:8317")).toEqual({ relay: { port: 8317, to: { host: "localhost", port: 8317 } }, url: "http://localhost:8317", boxUrl: "http://localhost:8317", label: "localhost:8317" });
  expect(reachOf("http://127.0.0.1:8317/v1").relay).toEqual({ port: 8317, to: { host: "127.0.0.1", port: 8317 } });
  expect(reachOf("http://[::1]:8317")).toMatchObject({ relay: { port: 8317, addr: "::1", to: { host: "::1", port: 8317 } }, label: "[::1]:8317" });
  // This machine's own tailnet or LAN address, or another tailnet host's, by IP: that IP on the box's loopback.
  for (const ip of ["100.64.0.10", "192.168.2.10", "100.88.1.2"])
    expect(reachOf(`http://${ip}:8317`)).toMatchObject({ relay: { port: 8317, addr: ip, to: { host: ip, port: 8317 } }, pin: { ip }, boxUrl: `http://${ip}:8317` });
  expect(reachOf("https://[fd7a:115c:a1e0::1]:8443")).toMatchObject({ relay: { port: 8443, addr: "fd7a:115c:a1e0::1" }, pin: { ip: "fd7a:115c:a1e0::1" }, label: "[fd7a:115c:a1e0::1]:8443" });
  // A tailnet host by name over https: the name pinned, the box listening at 40443, its claude pointed there.
  expect(reachOf("https://gateway.tail1234.ts.net")).toEqual({
    relay: { port: 40443, to: { host: "gateway.tail1234.ts.net", port: 443 } },
    pin: { name: "gateway.tail1234.ts.net" },
    url: "https://gateway.tail1234.ts.net",
    boxUrl: "https://gateway.tail1234.ts.net:40443",
    label: "gateway.tail1234.ts.net:443",
  });
  expect(reachOf("http://devbox/claude/").boxUrl).toBe("http://devbox:40080/claude/");
  expect(reachOf("http://devbox:8317")).toMatchObject({ relay: { port: 8317, to: { host: "devbox", port: 8317 } }, pin: { name: "devbox" }, boxUrl: "http://devbox:8317" });
  expect(reachOf(ANTHROPIC_API)).toMatchObject({ relay: { port: 40443, to: { host: "api.anthropic.com", port: 443 } }, pin: { name: "api.anthropic.com" } });
  // On a hosted box's own network: no relay, no pin, the URL as set.
  expect(reachOf(ANTHROPIC_API, { direct: true })).toEqual({ url: ANTHROPIC_API, boxUrl: ANTHROPIC_API, label: "api.anthropic.com:443" });
  expect(() => reachOf("not a url")).toThrow("isn't a URL");
  expect(() => reachOf("ftp://x")).toThrow("isn't http or https");
});

test("a hosted box reaches public endpoints itself; a tailnet, LAN or loopback one only through the node", async () => {
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

test("a box whose relay moved the port has its claude pointed there in --settings, above the user's and the project's", () => {
  const overlay = join(root, "overlay2.json");
  writeFileSync(overlay, JSON.stringify({ env: { OTHER: "x" }, hooks: { a: 1 } }));
  const r = reachOf("https://gateway.tail1234.ts.net");
  const args = boxArgs(["-p", "--settings", overlay, "--model", "m"], r);
  expect(args.slice(0, 2)).toEqual(["-p", "--settings"]);
  expect(JSON.parse(args[2]!)).toEqual({ env: { OTHER: "x", ANTHROPIC_BASE_URL: "https://gateway.tail1234.ts.net:40443" }, hooks: { a: 1 } });
  expect(args.slice(3)).toEqual(["--model", "m"]);
  expect(JSON.parse(boxArgs(["-p"], r).at(-1)!)).toEqual({ env: { ANTHROPIC_BASE_URL: "https://gateway.tail1234.ts.net:40443" } });
  // The port kept: claude's argv as it was.
  const same = ["-p", "--settings", overlay];
  expect(boxArgs(same, reachOf("http://localhost:8317"))).toBe(same);
  // What claude in the box then picks is the box's URL.
  expect(claudeEndpoint({ env: {}, args, cwd: root }).url).toBe("https://gateway.tail1234.ts.net:40443");
});

test("the pin runs only in a fleetd box, as root or through sudo, and the check sends no key", () => {
  const name = pinScript({ name: "gateway.tail1234.ts.net" });
  expect(name).toStartWith('[ -e /etc/fleetd/guest.env ] || { echo "not in a fleetd box"; exit 1; }');
  expect(name).toContain("sudo -n");
  expect(name).toContain("127.0.0.1 gateway.tail1234.ts.net");
  expect(name).toContain("> /etc/hosts");
  expect(pinScript({ ip: "100.88.1.2" })).toContain("ip addr replace '100.88.1.2/32' dev lo");
  expect(pinScript({ ip: "fd7a::1" })).toContain("ip -6 addr replace 'fd7a::1/128' dev lo nodad");
  const probe = probeArgv("https://gateway.tail1234.ts.net");
  expect(probe[0]).toBe("curl");
  expect(probe.join(" ")).not.toMatch(/-H|header|auth|key/i);
});

async function listenOn(host: string): Promise<number | undefined> {
  const s = createServer((c) => c.end());
  try {
    await new Promise<void>((resolve, reject) => s.once("error", reject).listen(0, host, () => resolve()));
  } catch {
    return undefined;
  }
  servers.push(s);
  return (s.address() as { port: number }).port;
}

test("a gateway on localhost is dialled where it listens: only 127.0.0.1, or only ::1", async () => {
  const v4 = (await listenOn("127.0.0.1"))!;
  expect(await loopbackFor(v4)).toBe("127.0.0.1");
  const v6 = await listenOn("::1");
  // A runner without IPv6 loopback has no v6-only gateway to find.
  if (v6 !== undefined) expect(await loopbackFor(v6)).toBe("::1");
  const closed = (await listenOn("127.0.0.1"))!;
  servers.pop()!.close();
  expect(await loopbackFor(closed, 200)).toBe("127.0.0.1");
});

/** A box that records what it was asked, and answers runs from `outcomes`. */
function fakeBox(outcomes: RunOutcome[]) {
  const runs: string[][] = [];
  const relays: Relay[] = [];
  const box = {
    run: async (r: { argv: string[] }) => (runs.push(r.argv), outcomes.shift()!),
    relay: async (r: Relay) => void relays.push(r),
  } as unknown as Box;
  return { box, runs, relays };
}

test("reach pins, relays and checks at the box's URL, and says plainly what failed", async () => {
  const ok: RunOutcome = { exitCode: 0, outputTail: "", timedOut: false };
  const r = reachOf("https://gateway.tail1234.ts.net");
  const good = fakeBox([ok, ok]);
  await reach(good.box, r);
  expect(good.runs.map((a) => a[0])).toEqual(["/bin/sh", "curl"]);
  expect(good.runs[1]!.at(-1)).toBe("https://gateway.tail1234.ts.net:40443");
  expect(good.relays).toEqual([r.relay!]);

  const noPin = fakeBox([{ exitCode: 1, outputTail: "sudo: a password is required\n", timedOut: false }]);
  await expect(reach(noPin.box, r)).rejects.toThrow("the box couldn't point gateway.tail1234.ts.net:443 at the node: sudo: a password is required");
  const down = fakeBox([ok, { exitCode: 7, outputTail: "curl: (7) Failed to connect to gateway.tail1234.ts.net port 40443\n", timedOut: false }]);
  await expect(reach(down.box, r)).rejects.toThrow("the box can't reach Claude at gateway.tail1234.ts.net:443: curl: (7) Failed to connect");
  // A loopback endpoint pins nothing, and its relay dials the loopback address that answers.
  const v4 = (await listenOn("127.0.0.1"))!;
  const local = fakeBox([ok]);
  await reach(local.box, reachOf(`http://localhost:${v4}`));
  expect(local.runs.map((a) => a[0])).toEqual(["curl"]);
  expect(local.relays).toEqual([{ port: v4, to: { host: "127.0.0.1", port: v4 } }]);
  // A public endpoint on a hosted box's own network: only the check.
  const direct = fakeBox([ok]);
  await reach(direct.box, reachOf(ANTHROPIC_API, { direct: true }));
  expect(direct.runs).toEqual([probeArgv(ANTHROPIC_API)]);
  expect(direct.relays).toEqual([]);
});
