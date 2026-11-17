// How a box reaches Claude (src/node/place/endpoint.ts): the endpoint claude itself picks, from its environment and
// each settings file in claude's own order, and for every kind of endpoint (this machine's loopback, its LAN or
// tailnet address, another tailnet host by name or IP, http or https, Anthropic's API) the relay, the pin and the
// check that make it reachable from inside a box through the node.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunOutcome } from "../../src/node/cmd/index.ts";
import { ANTHROPIC_API, claudeEndpoint, pinScript, probeArgv, reach, reachOf } from "../../src/node/place/endpoint.ts";
import type { Box, Relay } from "../../src/node/sandbox/box.ts";

const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-endpoint-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const settings = (file: string, url: string) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: url } }));
};

test("the endpoint is the one claude picks: its environment, then each settings file in claude's order", () => {
  const cfg = join(root, "cfg");
  const cwd = join(root, "wt");
  const managed = join(root, "managed.json");
  mkdirSync(cwd, { recursive: true });
  const l = { env: { CLAUDE_CONFIG_DIR: cfg } as Record<string, string>, args: [] as string[], cwd };
  expect(claudeEndpoint(l, managed)).toEqual({ url: ANTHROPIC_API, source: "Anthropic's API, the default" });
  l.env.ANTHROPIC_BASE_URL = "http://localhost:1";
  expect(claudeEndpoint(l, managed)).toEqual({ url: "http://localhost:1", source: "the environment" });
  // The user's settings win over the environment: the devbox's gateway is set only there.
  settings(join(cfg, "settings.json"), "http://localhost:8317");
  expect(claudeEndpoint(l, managed)).toEqual({ url: "http://localhost:8317", source: join(cfg, "settings.json") });
  settings(join(cwd, ".claude", "settings.json"), "http://project:2");
  expect(claudeEndpoint(l, managed).url).toBe("http://project:2");
  settings(join(cwd, ".claude", "settings.local.json"), "http://local:3");
  expect(claudeEndpoint(l, managed).url).toBe("http://local:3");
  const overlay = join(root, "overlay.json");
  writeFileSync(overlay, JSON.stringify({ env: { OTHER: "x" } }));
  l.args = ["--settings", overlay];
  expect(claudeEndpoint(l, managed).url).toBe("http://local:3");
  l.args = ["--settings", overlay, "--settings", JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://inline:4" } })];
  expect(claudeEndpoint(l, managed)).toEqual({ url: "https://inline:4", source: "--settings" });
  settings(managed, "https://managed:5");
  expect(claudeEndpoint(l, managed)).toEqual({ url: "https://managed:5", source: managed });
});

test("every kind of endpoint gets a relay through the node, with its name or IP kept so TLS still checks it", () => {
  const relay = (url: string) => reachOf(url);
  // This machine's loopback: the box's own loopback at the same port, nothing pinned.
  expect(relay("http://localhost:8317")).toEqual({ relay: { port: 8317, to: { host: "localhost", port: 8317 } }, url: "http://localhost:8317", label: "localhost:8317" });
  expect(relay("http://127.0.0.1:8317/v1").relay).toEqual({ port: 8317, to: { host: "127.0.0.1", port: 8317 } });
  expect(relay("http://[::1]:8317").relay).toEqual({ port: 8317, addr: "::1", to: { host: "::1", port: 8317 } });
  expect(relay("http://[::1]:8317").label).toBe("[::1]:8317");
  // This machine's own tailnet or LAN address, or another tailnet host's, by IP: that IP on the box's loopback.
  for (const ip of ["100.64.0.10", "192.168.2.10", "100.88.1.2"])
    expect(relay(`http://${ip}:8317`)).toMatchObject({ relay: { port: 8317, addr: ip, to: { host: ip, port: 8317 } }, pin: { ip } });
  expect(relay("https://[fd7a:115c:a1e0::1]:8443")).toMatchObject({ relay: { port: 8443, addr: "fd7a:115c:a1e0::1" }, pin: { ip: "fd7a:115c:a1e0::1" }, label: "[fd7a:115c:a1e0::1]:8443" });
  // A tailnet host by name, http or https, and Anthropic's own API: the name pinned to the box's loopback.
  expect(relay("https://gateway.tail1234.ts.net")).toEqual({
    relay: { port: 443, to: { host: "gateway.tail1234.ts.net", port: 443 } },
    pin: { name: "gateway.tail1234.ts.net" },
    url: "https://gateway.tail1234.ts.net",
    label: "gateway.tail1234.ts.net:443",
  });
  expect(relay("http://devbox:8317")).toMatchObject({ relay: { port: 8317, to: { host: "devbox", port: 8317 } }, pin: { name: "devbox" } });
  expect(relay(ANTHROPIC_API)).toMatchObject({ relay: { port: 443, to: { host: "api.anthropic.com", port: 443 } }, pin: { name: "api.anthropic.com" } });
  expect(() => relay("not a url")).toThrow("isn't a URL");
  expect(() => relay("ftp://x")).toThrow("isn't http or https");
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

test("reach pins, relays and checks, and says plainly what failed", async () => {
  const ok: RunOutcome = { exitCode: 0, outputTail: "", timedOut: false };
  const r = reachOf("https://gateway.tail1234.ts.net");
  const good = fakeBox([ok, ok]);
  await reach(good.box, r);
  expect(good.runs.map((a) => a[0])).toEqual(["/bin/sh", "curl"]);
  expect(good.relays).toEqual([r.relay]);

  const noPin = fakeBox([{ exitCode: 1, outputTail: "sudo: a password is required\n", timedOut: false }]);
  await expect(reach(noPin.box, r)).rejects.toThrow("the box couldn't point gateway.tail1234.ts.net:443 at the node: sudo: a password is required");
  const down = fakeBox([ok, { exitCode: 7, outputTail: "curl: (7) Failed to connect to gateway.tail1234.ts.net port 443\n", timedOut: false }]);
  await expect(reach(down.box, r)).rejects.toThrow("the box can't reach Claude at gateway.tail1234.ts.net:443: curl: (7) Failed to connect");
  // A loopback endpoint pins nothing.
  const local = fakeBox([ok]);
  await reach(local.box, reachOf("http://localhost:8317"));
  expect(local.runs.map((a) => a[0])).toEqual(["curl"]);
});
