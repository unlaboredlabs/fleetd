// Restart hub, run on the binary: a throwaway hub (its own FLEETD_HOME, HOME, XDG_CONFIG_HOME and port) whose unit
// file names the binary, and stubs for `systemd-run` and `systemctl` on its PATH, so nothing here reaches this
// machine's real services. An admin's hub_restart hands `systemctl --user restart fleetd-hub.service` to systemd-run,
// the call is answered, the hub exits cleanly and comes back on the same home; a member's key and an agent's are
// refused and nothing restarts. The test plays the service manager: the stub stops the hub it started, and the test starts the next one.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpClient } from "../../src/cli/mcp_client.ts";
import { tempHome } from "../helpers.ts";
import { BIN, cleanEnv, freePort, run, script } from "./kit.ts";

setDefaultTimeout(90_000);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const done of cleanups.splice(0).reverse()) await done();
});

async function healthy(url: string): Promise<boolean> {
  for (let i = 0; i < 300; i++) {
    const ok = await fetch(`${url}/healthz`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return true;
    await Bun.sleep(50);
  }
  return false;
}

test.skipIf(!BIN || process.platform !== "linux")("an admin restarts the hub from outside its service, and it comes back; a member and an agent are refused", async () => {
  const home = tempHome();
  cleanups.push(home.done);
  const root = home.dir;
  const fleet = join(root, "fleet");
  const hubHome = join(fleet, "hub");
  const units = join(root, "xdg/systemd/user");
  const stubs = join(root, "stubs");
  for (const dir of [join(root, "user"), units, stubs]) mkdirSync(dir, { recursive: true });
  const log = join(root, "service-calls.log");
  const pidFile = join(root, "hub.pid");
  // systemd-run starts its command and returns; systemctl stops the hub this test started, as a restart's first half.
  script(join(stubs, "systemd-run"), `echo "systemd-run $*" >> '${log}'\nshift 5\n"$@" > /dev/null 2>&1 &\n`);
  script(join(stubs, "systemctl"), `echo "systemctl $*" >> '${log}'\nif [ "$*" = "--user restart fleetd-hub.service" ]; then kill -TERM "$(cat '${pidFile}')"; fi\n`);
  const env = cleanEnv({
    HOME: join(root, "user"),
    XDG_CONFIG_HOME: join(root, "xdg"),
    XDG_RUNTIME_DIR: join(root, "run"),
    FLEETD_HOME: fleet,
    PATH: `${stubs}:${process.env.PATH ?? ""}`,
  });
  const port = freePort();
  const url = `http://127.0.0.1:${port}`;
  const fleetd = (...args: string[]) => run([BIN!, ...args], env);

  const init = await fleetd("init", "--no-service", "--listen", `127.0.0.1:${port}`);
  expect(init.code, init.stderr).toBe(0);
  // The unit `fleetd init` would have written: what tells the hub it runs as a service it can restart.
  writeFileSync(join(units, "fleetd-hub.service"), `[Service]\nExecStart=${realpathSync(BIN!)} hub start --home ${hubHome}\n`);
  const key = async (name: string, role: string, human = true) => {
    const out = join(root, `${name}.key`);
    const made = await fleetd("hub", "key", "create", ...(human ? ["--human"] : []), "--name", name, "--role", role, "--machines", "*", "--out", out);
    expect(made.code, made.stderr).toBe(0);
    return readFileSync(out, "utf8").trim();
  };
  const admin = await key("admin-laptop", "admin");
  const member = await key("member-laptop", "operate");
  const agent = await key("agent", "admin", false);

  const hub = () => {
    const child = Bun.spawn([BIN!, "hub", "start", "--home", hubHome, "--listen", `127.0.0.1:${port}`], { cwd: root, env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    // Only the hub this test started, should an assertion fail while it runs.
    cleanups.push(() => void child.kill("SIGKILL"));
    writeFileSync(pidFile, String(child.pid));
    return child;
  };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");

  const first = hub();
  expect(await healthy(url), "the hub came up").toBe(true);

  // A member's key lacks the role; an agent's admin key is no person's.
  for (const [refusedKey, why] of [
    [member, "This key lacks the admin role."],
    [agent, "it needs a person's key with Admin on every machine"],
  ] as const) {
    const client = await McpClient.connect(url, refusedKey, "blackbox", 10_000);
    const refused = await client.callTool("hub_restart", {}, 10_000);
    expect(refused.isError).toBe(true);
    expect(refused.body).toMatchObject({ code: "forbidden" });
    expect(refused.body.message).toContain(why);
  }
  expect(calls()).not.toContain("restart");

  const asAdmin = await McpClient.connect(url, admin, "blackbox", 10_000);
  const answered = await asAdmin.callTool("hub_restart", {}, 10_000);
  expect(answered.isError, JSON.stringify(answered.body)).toBe(false);
  expect(answered.body).toMatchObject({ leads: 0 });
  expect(answered.body.next).toContain("The hub restarts now");

  // Stopped by its service manager, it exits cleanly; nothing else of this test stops it.
  expect(await first.exited).toBe(0);
  expect(first.signalCode).toBeNull();
  const said = calls().trim().split("\n");
  expect(said[0]).toMatch(/^systemd-run --user --collect --quiet --unit fleetd-restart-\d+ systemctl --user restart fleetd-hub\.service$/);
  expect(said[1]).toBe("systemctl --user restart fleetd-hub.service");

  // The restart's second half: the same home comes up again and knows the same keys.
  const second = hub();
  expect(await healthy(url), "the hub came back").toBe(true);
  const again = await McpClient.connect(url, admin, "blackbox", 10_000);
  expect((await again.callTool("hub_info", {}, 10_000)).body).toMatchObject({ admin: true });
  second.kill("SIGTERM");
  expect(await second.exited).toBe(0);
});
