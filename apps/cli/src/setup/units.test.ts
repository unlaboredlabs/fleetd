import { describe, expect, it } from "vitest";
import { parseGitIdentity } from "./state.ts";
import { renderLaunchdPlist, renderSystemdUnit, type ServiceSpec } from "./units.ts";

const spec: ServiceSpec = {
  role: "node",
  suffix: "-fleetdlab",
  description: "fleetd node",
  program: ["/usr/bin/node", "/home/a b/cli/bin.js", "node", "run", "--home", "/home/a b/.fleetd/node", "100%", "$HOME"],
  env: { HOME: "/home/a b", PATH: "/usr/bin:/bin" },
  envFile: "/home/a b/.fleetd/t3.env",
  workingDirectory: "/home/a b",
  logPath: "/home/a b/.fleetd/logs/node.log",
};

describe("service units", () => {
  it("systemd: quotes spaces, escapes % and $, and reads secrets only from the env file", () => {
    const unit = renderSystemdUnit(spec);
    expect(unit).toContain('ExecStart=/usr/bin/node "/home/a b/cli/bin.js" node run --home "/home/a b/.fleetd/node" 100%% $$HOME');
    expect(unit).toContain('Environment="HOME=/home/a b"');
    expect(unit).toContain('EnvironmentFile=-"/home/a b/.fleetd/t3.env"');
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("launchd: sources the env file through sh, labels by role and suffix, escapes XML", () => {
    const plist = renderLaunchdPlist({ ...spec, env: { PATH: "/a&b" } });
    expect(plist).toContain("<string>sh.fleetd.node-fleetdlab</string>");
    expect(plist).toContain(`<string>[ -f '/home/a b/.fleetd/t3.env' ] &amp;&amp; set -a &amp;&amp; . '/home/a b/.fleetd/t3.env' &amp;&amp; set +a; exec "$@"</string>`);
    expect(plist).toContain("<string>/a&amp;b</string>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
  });
});

describe("hub setup state", () => {
  it("parses a git identity", () => {
    expect(parseGitIdentity("wynn-dev <66362261+wynn-dev@users.noreply.github.com>")).toEqual({ name: "wynn-dev", email: "66362261+wynn-dev@users.noreply.github.com" });
    expect(parseGitIdentity("no email")).toBeUndefined();
  });
});
