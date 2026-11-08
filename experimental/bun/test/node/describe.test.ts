// `describe()`: which Claude Code setup sessions here use, from the zero-cost probe and the user settings: its
// version, login, proxy and where it is set, and the config dir.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe as describeSetup, fromInfo, setupLine } from "../../src/node/runner/claude/describe.ts";
import { accountOverrides, loginLabel, proxyOf, tilde } from "../../src/node/runner/claude/setup.ts";
import { tempHome } from "../helpers.ts";

test("describe() probes the claude sessions would run: its version, its login, the proxy from its user settings", async () => {
  const home = tempHome();
  try {
    const fake = join(home.dir, "fake-claude");
    writeFileSync(fake, `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, "../../../../tests/lab/factory/fakeClaude.ts")}' "$@"\n`);
    chmodSync(fake, 0o755);
    mkdirSync(join(home.dir, ".claude"));
    writeFileSync(join(home.dir, ".claude/settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8899/", ANTHROPIC_API_KEY: "x" } }));
    const setup = await describeSetup(fake, { HOME: home.dir, PATH: process.env.PATH ?? "/usr/bin:/bin" });
    expect(setup).toEqual({
      version: "2.1.302",
      loginKind: "API key",
      proxy: "http://127.0.0.1:8899",
      proxySource: tilde(join(home.dir, ".claude/settings.json")),
      configDir: join(home.dir, ".claude"),
    });
    expect(setupLine(setup)).toBe(`claude 2.1.302, logged in (API key), via proxy http://127.0.0.1:8899 from ${tilde(join(home.dir, ".claude/settings.json"))}`);
    expect(accountOverrides({ HOME: home.dir })).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]);
    const missing = await describeSetup(join(home.dir, "no-such-claude"), { HOME: home.dir, PATH: "/usr/bin:/bin" });
    expect(missing.version).toBeUndefined();
    expect(setupLine(missing)).toBe("claude is not usable");
  } finally {
    home.done();
  }
});

test("a probe's report reads as a person's words; the proxy and the login label come from where claude finds them", () => {
  const info = { runner: "claude" as const, supported: "x", versionOk: true, login: "logged_in" as const, loginKind: "subscription", loginLabel: "Max", version: "2.1.314 (Claude Code)", configDir: "/srv/claude" };
  expect(setupLine(fromInfo(info))).toBe("claude 2.1.314, logged in (Max), config /srv/claude");
  expect(setupLine(fromInfo({ ...info, login: "logged_out", problem: "claude is not logged in" }))).toBe("claude 2.1.314, not logged in, config /srv/claude");
  expect(loginLabel({ subscriptionType: "max" })).toBe("Max");
  expect(loginLabel({ apiProvider: "bedrock" })).toBe("Bedrock");
  expect(loginLabel({ tokenSource: "ANTHROPIC_AUTH_TOKEN" })).toBe("gateway token");
  expect(loginLabel({ apiKeySource: "apiKeyHelper" })).toBe("API key from apiKeyHelper");
  expect(proxyOf({ HOME: "/nowhere", ANTHROPIC_BASE_URL: "https://api.anthropic.com/" })).toBeUndefined();
  expect(proxyOf({ HOME: "/nowhere", ANTHROPIC_BASE_URL: "http://gw:1/", FLEETD_ENV_SOURCE: "~/.fleetd/claude.env" })).toEqual({ url: "http://gw:1", source: "~/.fleetd/claude.env" });
});

test("describe()'s default is a session's own environment: the claude.env a gateway's proxy lives in is read", async () => {
  const home = tempHome();
  const saved = { HOME: process.env.HOME, FLEETD_HOME: process.env.FLEETD_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  try {
    const fake = join(home.dir, "fake-claude");
    writeFileSync(fake, `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, "../../../../tests/lab/factory/fakeClaude.ts")}' "$@"\n`);
    chmodSync(fake, 0o755);
    mkdirSync(join(home.dir, ".fleetd"), { recursive: true });
    writeFileSync(join(home.dir, ".fleetd/claude.env"), "ANTHROPIC_BASE_URL=http://gateway.devbox:9000\n");
    process.env.HOME = home.dir;
    process.env.FLEETD_HOME = join(home.dir, ".fleetd");
    delete process.env.CLAUDE_CONFIG_DIR;
    const setup = await describeSetup(fake);
    expect(setup).toMatchObject({ proxy: "http://gateway.devbox:9000", proxySource: "~/.fleetd/claude.env", configDir: join(home.dir, ".claude") });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    home.done();
  }
});
