import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseListen } from "@fleetd/hub/main.ts";
import * as HttpApp from "@fleetd/hub/api/HttpApp.ts";
import * as HubDb from "@fleetd/hub/store/HubDb.ts";
import * as Effect from "effect/Effect";
import { openHub, pairingLink, probeListen, processesHolding } from "./hubAccess.ts";
import { runLocal } from "./ssh.ts";
import { ensureVapidKeys, isNoreply, parseGitIdentity, readSetup, writeSetup } from "./state.ts";
import { type Platform, renderUnit, serviceManager, type ServiceSpec, unitPath, unitSuffix } from "./units.ts";

export const SETUP_USAGE = `  init [--home <dir>] [--listen <host:port>] [--url <url>] [--name <device>]
       [--git-identity "Name <email>"] [--no-service] [--unit-suffix <s>]
             set up this machine as the hub: home (default ~/.fleetd/hub), Web Push keys, a user
             service (systemd or launchd) that keeps it running, and a one-time pairing link for
             your first device (--name, default phone) at --url (default http://<listen>);
             --git-identity is the commit author for every machine (the GitHub noreply address
             for public repos); --no-service prepares everything but leaves starting it to you
  uninstall [--home <dir>] [--purge]
             stop and remove the hub's service; its data stays unless --purge
`;

const say = (line = "") => process.stderr.write(`${line}\n`);
const fail = (message: string) => {
  say(`fleetd: ${message}`);
  return 1;
};
const usage = (message: string) => {
  say(`fleetd: ${message}\n\nusage:\n${SETUP_USAGE}`);
  return 2;
};

export const localPlatform = (): Platform | undefined => (process.platform === "linux" || process.platform === "darwin" ? process.platform : undefined);
export const localDirs = () => ({ home: os.homedir(), configHome: process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config") });

const sh = async (command: string) => {
  say(`  $ ${command}`);
  const result = await runLocal("/bin/sh", ["-c", command]);
  if (result.code !== 0) throw new Error(`${command} failed (exit ${result.code}): ${result.stderr.trim()}`);
};

/** The hub service runs this very CLI with the Node running it now. */
export const hubServiceSpec = (input: { readonly home: string; readonly listen: string; readonly suffix: string; readonly cli: string; readonly node: string; readonly path: string }): ServiceSpec => ({
  role: "hub",
  suffix: input.suffix,
  description: "fleetd hub",
  program: [input.node, input.cli, "hub", "start", "--home", input.home, "--listen", input.listen],
  // The hub runs gh, git and `claude -p`, so it keeps the PATH it was set up from.
  env: { HOME: os.homedir(), PATH: input.path, LANG: "C.UTF-8" },
  workingDirectory: input.home,
  logPath: path.join(input.home, "hub.log"),
});

const initCommand = async (argv: ReadonlyArray<string>): Promise<number> => {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        home: { type: "string" },
        listen: { type: "string" },
        url: { type: "string" },
        name: { type: "string" },
        "git-identity": { type: "string" },
        "no-service": { type: "boolean" },
        "unit-suffix": { type: "string" },
      },
    }));
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }
  const resolved = Effect.runSync(Effect.result(HubDb.resolveHubHome(values.home)));
  if (resolved._tag === "Failure") return fail(resolved.failure.message);
  const home = resolved.success;
  const previous = readSetup(home);
  const listenText = values.listen ?? previous?.listen ?? `${HttpApp.DEFAULT_LISTEN.host}:${HttpApp.DEFAULT_LISTEN.port}`;
  const listen = parseListen(listenText);
  if (listen === undefined) return usage(`--listen must be host:port, got '${listenText}'`);
  const url = values.url ?? previous?.url ?? `http://${listenText}`;
  try {
    new URL(url);
  } catch {
    return usage(`--url must be the hub's address, e.g. https://forge.tailnet.ts.net, got '${url}'`);
  }
  const identity = values["git-identity"] === undefined ? previous?.gitIdentity : parseGitIdentity(values["git-identity"]);
  if (values["git-identity"] !== undefined && identity === undefined) return usage(`--git-identity must look like "Name <email>", got '${values["git-identity"]}'`);
  const suffix = values["unit-suffix"] === undefined ? (previous?.unitSuffix ?? "") : unitSuffix(values["unit-suffix"]);
  if (suffix === undefined) return usage(`--unit-suffix takes letters, digits and dashes, got '${values["unit-suffix"]}'`);
  const withService = values["no-service"] !== true;
  const platform = localPlatform();
  if (withService && platform === undefined) return fail(`fleetd runs the hub as a systemd or launchd service, not on ${process.platform}; use --no-service and run fleetd hub start yourself`);

  const holders = processesHolding(path.join(home, "hub.sqlite"));
  if (holders.length > 0) return fail(`a hub already runs on ${home} (pid ${holders.join(", ")}); stop it first (fleetd uninstall keeps its data)`);
  const atListen = await probeListen(listen);
  if (atListen !== "free") return fail(atListen === "hub" ? `a fleetd hub already answers at ${listenText}` : `${listenText} is in use by something else; pick another --listen`);

  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  say(`hub home ${home}`);
  say(ensureVapidKeys(home) ? "created Web Push (VAPID) keys in vapid.json" : "kept the existing Web Push keys in vapid.json");
  writeSetup(home, { listen: listenText, url, unitSuffix: suffix, ...(identity === undefined ? {} : { gitIdentity: identity }), machines: previous?.machines ?? {} });
  if (identity === undefined) say('no commit identity yet: add one with --git-identity "Name <id+user@users.noreply.github.com>" before adding machines');
  else say(`commit identity ${identity.name} <${identity.email}>${isNoreply(identity) ? "" : " (not a GitHub noreply address: commits in public repos will show it)"}`);

  const hub = openHub(home);
  let pairing;
  try {
    pairing = await hub.runPromise(pairingLink(values.name ?? "phone", url));
  } finally {
    await hub.dispose();
  }

  if (withService && platform !== undefined) {
    const cli = fs.realpathSync(process.argv[1] ?? "");
    const spec = hubServiceSpec({ home, listen: listenText, suffix, cli, node: process.execPath, path: [path.dirname(process.execPath), process.env.PATH ?? ""].join(":") });
    const file = unitPath(platform, localDirs(), "hub", suffix);
    const text = renderUnit(platform, spec);
    const existed = fs.existsSync(file);
    const changed = !existed || fs.readFileSync(file, "utf8") !== text;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    say(`${changed ? "wrote" : "kept"} ${file}`);
    const services = serviceManager(platform, process.getuid?.() ?? 0, suffix, () => file);
    try {
      await sh(services.restart("hub", changed && existed));
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    const deadline = Date.now() + 30_000;
    while ((await probeListen(listen)) !== "hub") {
      if (Date.now() > deadline) return fail(`the hub service did not answer at ${listenText} within 30 s; see ${spec.logPath}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    say(`the hub runs as a service and answers at ${listenText}`);
  } else {
    say(`not installing a service; run the hub yourself with:\n  fleetd hub start --home ${home} --listen ${listenText}`);
  }

  say(`one-time pairing link for ${values.name ?? "phone"}, valid until ${pairing.expiresAt}. Open it on the device:`);
  process.stdout.write(`${pairing.link}\n`);
  say("next: fleetd machine add <ssh-host> for each machine that runs agents");
  return 0;
};

const uninstallCommand = async (argv: ReadonlyArray<string>): Promise<number> => {
  let values;
  try {
    ({ values } = parseArgs({ args: [...argv], options: { home: { type: "string" }, purge: { type: "boolean" } } }));
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }
  const resolved = Effect.runSync(Effect.result(HubDb.resolveHubHome(values.home)));
  if (resolved._tag === "Failure") return fail(resolved.failure.message);
  const home = resolved.success;
  const state = readSetup(home);
  const platform = localPlatform();
  if (platform !== undefined) {
    const suffix = state?.unitSuffix ?? "";
    const file = unitPath(platform, localDirs(), "hub", suffix);
    if (fs.existsSync(file)) {
      try {
        await sh(serviceManager(platform, process.getuid?.() ?? 0, suffix, () => file).remove("hub"));
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
      fs.rmSync(file);
      say(`removed ${file}`);
      if (platform === "linux") await sh(`XDG_RUNTIME_DIR=/run/user/${process.getuid?.() ?? 0} systemctl --user daemon-reload`).catch(() => undefined);
    } else {
      say(`no hub service at ${file}`);
    }
  }
  const machines = Object.keys(state?.machines ?? {});
  if (machines.length > 0) say(`machines still set up from this hub: ${machines.join(", ")} (fleetd machine remove <id> undoes each)`);
  if (values.purge !== true) {
    say(`kept the hub's data in ${home}; fleetd init starts it again, --purge deletes it`);
    return 0;
  }
  if (!fs.existsSync(path.join(home, "hub.sqlite")) && state === undefined) return fail(`${home} does not look like a hub home (no hub.sqlite or setup.json); not deleting it`);
  const holders = processesHolding(path.join(home, "hub.sqlite"));
  if (holders.length > 0) return fail(`a hub still runs on ${home} (pid ${holders.join(", ")}); stop it before --purge`);
  fs.rmSync(home, { recursive: true, force: true });
  say(`deleted ${home}`);
  return 0;
};

/** `fleetd init` and `fleetd uninstall`. */
export const setupCommand = (command: "init" | "uninstall", argv: ReadonlyArray<string>) =>
  command === "init" ? initCommand(argv) : uninstallCommand(argv);
