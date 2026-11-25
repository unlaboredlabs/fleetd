// "hub" became "workspace" in the CLI: `fleetd workspace …` and `--workspace`, with the old `hub …` commands and
// `--hub`/`--hub-url` flags still taken, word for word the same, and named in no usage.
import { describe, expect, test } from "bun:test";
import { parse } from "../../src/cli/args.ts";
import { helpFor, usageText } from "../../src/cli/index.ts";
import { serviceSteps } from "../../src/cli/workspace.ts";
import { Fleet } from "./golden.ts";

const CASE_MS = 30_000;

/** Each new form beside its old one: both run the same and say the same. */
const PAIRS: [string[], string[]][] = [
  [["workspace", "--help"], ["hub", "--help"]],
  [["workspace", "start", "--help"], ["hub", "start", "--help"]],
  [["workspace", "key", "--help"], ["hub", "key", "--help"]],
  [["workspace", "frob"], ["hub", "frob"]],
  [["workspace", "key", "create"], ["hub", "key", "create"]],
  [["workspace", "key", "list"], ["hub", "key", "list"]],
  [["workspace", "start", "--listen", "nope"], ["hub", "start", "--listen", "nope"]],
  [["node", "join", "--workspace", "http://h", "--machine", "m"], ["node", "join", "--hub", "http://h", "--machine", "m"]],
  [["status", "--workspace", "x"], ["status", "--hub", "x"]],
  [["time", "--workspace", "http://x"], ["time", "--hub", "http://x"]],
  [["push-relay", "set", "off", "--workspace", "x"], ["push-relay", "set", "off", "--hub", "x"]],
  [["steer", "T1", "hi", "--key-file", "nope.key", "--workspace", "http://127.0.0.1:1"], ["steer", "T1", "hi", "--key-file", "nope.key", "--hub", "http://127.0.0.1:1"]],
];

describe("old forms run as the new ones", () => {
  for (const [now, old] of PAIRS) {
    test(`${now.join(" ")} = ${old.join(" ")}`, async () => {
      const fleet = new Fleet(`workspace-${now.join("-").replace(/[^\w.-]/g, "_")}`);
      try {
        const a = fleet.normalize(await fleet.run(now));
        const b = fleet.normalize(await fleet.run(old));
        expect(b).toEqual(a);
        expect(`${a.stdout}${a.stderr}`).not.toMatch(/Unknown option|unknown command/);
      } finally {
        await fleet.stop();
      }
    }, CASE_MS);
  }
});

test("help names the new forms only", () => {
  const help = usageText();
  expect(help).toContain("  workspace start ");
  expect(help).toContain("  workspace stop\n");
  expect(help).toContain("  workspace restart\n");
  expect(help).toContain("  workspace key create ");
  expect(help).toContain("[--workspace <url>]");
  expect(help).not.toMatch(/^ {2}hub /m);
  expect(help).not.toMatch(/--hub\b/);
  // The workspace's home on disk keeps its name (~/.fleetd/hub): existing installs keep their data where it is.
  expect(help.replaceAll("~/.fleetd/hub", "")).not.toMatch(/\b[Hh]ubs?\b/);
  expect(helpFor(["hub", "--help"])).toBe(helpFor(["workspace", "--help"]));
});

test("--hub and --hub-url are --workspace and --workspace-url", () => {
  const spec = { options: { workspace: "str", "workspace-url": "str" } as const, positionals: false };
  const p = parse(["--hub", "http://a", "--hub-url=http://b"], spec);
  if (p instanceof Error) throw p;
  expect(p.str("workspace")).toBe("http://a");
  expect(p.str("workspace-url")).toBe("http://b");
  expect(p.keys()).toEqual(["workspace", "workspace-url"]);
  // Where a command takes no --workspace, --hub is as unknown as ever.
  const none = parse(["--hub", "x"], { options: {}, positionals: false });
  expect(none instanceof Error && none.message).toBe("Unknown option '--hub'");
});

describe("workspace stop and restart", () => {
  const hub = { name: "fleetd-hub.service", unit: "hub" };
  test("systemd stops and restarts the unit, which starts a stopped one", () => {
    expect(serviceSteps("stop", hub, "linux", false)).toEqual([["systemctl", ["--user", "stop", "fleetd-hub.service"]]]);
    expect(serviceSteps("restart", hub, "linux", false)).toEqual([["systemctl", ["--user", "restart", "fleetd-hub.service"]]]);
  });
  test("launchd boots out a loaded one, and bootstraps a stopped one to start it", () => {
    const mac = { name: "sh.fleetd.hub.plist", unit: "hub" };
    const [stop] = serviceSteps("stop", mac, "darwin", true);
    expect(stop?.[0]).toBe("launchctl");
    expect(stop?.[1][0]).toBe("bootout");
    expect(serviceSteps("stop", mac, "darwin", false)).toEqual([]);
    expect(serviceSteps("restart", mac, "darwin", false)[0]?.[1][0]).toBe("bootstrap");
  });
});
