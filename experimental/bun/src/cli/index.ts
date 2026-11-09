// The `fleetd` command line (crates/fleetd/src/cli/mod.rs): one binary, the same subcommands, arguments, output and
// exit codes as the Rust one. Exit codes: 0 ok, 1 failed, 2 usage, 3 refused, 4 hub or node unreachable.
// Every command is a dynamic import, so a short one (`fleetd version`) loads only what it uses: cold start matters.
import { initFromArgv } from "../shared/home.ts";
import { keepRunningBinary } from "../update/running.ts";
import { NotImplemented } from "../shared/errors.ts";
import { emit } from "./result.ts";
import * as U from "./usages.ts";
import { versionLine } from "./versions.ts";

export { versionLine };

export const usageText = () => `usage: fleetd <command>

commands:
  version    print the fleetd version and protocol
  help       show this message
${U.UPDATE_USAGE}
setting up (on the hub machine):
${U.SETUP_USAGE}${U.machineUsage()}${U.PAIR_USAGE}${U.PEOPLE_USAGE}${U.GITHUB_APP_USAGE}
projects:
${U.PROJECT_USAGE}${U.NAVI_USAGE}
running by hand:
${U.HUB_START_USAGE}${U.HUB_KEY_USAGE}${U.NODE_USAGE}${U.PROMPTS_USAGE}${U.PUSH_RELAY_USAGE}${U.TIME_USAGE}${U.METRICS_USAGE}${U.STATUS_USAGE}${U.USAGE_USAGE}${U.CLOUD_USAGE}${U.STEER_USAGE}${U.CHAT_USAGE}${U.WORK_USAGE}`;

/** `fleetd <command> … --help` (or `-h`): that command's usage. After `--` they are arguments. */
export function helpFor(argv: string[]): string | undefined {
  const [command, ...rest] = argv;
  if (command === undefined) return undefined;
  const until = rest.indexOf("--");
  const asked = (until < 0 ? rest : rest.slice(0, until)).some((a) => a === "--help" || a === "-h");
  if (!asked) return undefined;
  const text = ((): string | undefined => {
    switch (command) {
      case "init":
      case "doctor":
      case "uninstall":
        return U.SETUP_USAGE;
      case "machine":
        return U.machineUsage();
      case "pair":
        return U.PAIR_USAGE;
      case "invite":
      case "people":
        return U.PEOPLE_USAGE;
      case "github-app":
        return U.GITHUB_APP_USAGE;
      case "project":
        return U.PROJECT_USAGE;
      case "navi":
      case "navis":
        return U.NAVI_USAGE;
      case "hub":
        return rest[0] === "start"
          ? U.HUB_START_USAGE
          : rest[0] === "key"
            ? U.HUB_KEY_USAGE
            : `${U.HUB_START_USAGE}${U.HUB_KEY_USAGE}`;
      case "node":
        return U.NODE_USAGE;
      case "prompts":
      case "instructions":
        return U.PROMPTS_USAGE;
      case "push-relay":
        return U.PUSH_RELAY_USAGE;
      case "time":
        return U.TIME_USAGE;
      case "metrics":
        return U.METRICS_USAGE;
      case "update":
        return U.UPDATE_USAGE;
      case "status":
        return U.STATUS_USAGE;
      case "usage":
        return U.USAGE_USAGE;
      case "cloud":
        return U.CLOUD_USAGE;
      case "steer":
      case "steers":
        return U.STEER_USAGE;
      case "chat":
        return U.CHAT_USAGE;
      case "work":
        return U.WORK_USAGE;
      default:
        return undefined;
    }
  })();
  return text === undefined ? undefined : `usage:\n${text}`;
}

/** The commands that wait on other processes or the hub (`is_long_running` in the Rust CLI). */
async function longRunning(command: string, rest: string[]): Promise<number | undefined> {
  switch (command) {
    case "init":
      return (await import("./setup/index.ts")).initCommand(rest);
    case "doctor":
      return (await import("./setup/doctor.ts")).doctorCommand(rest);
    case "uninstall":
      return (await import("./setup/index.ts")).uninstallCommand(rest);
    case "machine":
      return (await import("./setup/machine.ts")).machineCommand(rest);
    case "github-app":
      return (await import("./github_app.ts")).githubAppCommand(rest);
    case "project":
      return (await import("./project.ts")).projectCommand(rest);
    case "navi":
    case "navis":
      return (await import("./navi.ts")).naviCommand(rest);
    case "node":
      return (await import("./node.ts")).nodeCommand(rest);
    case "time":
      return (await import("./time.ts")).timeCommand(rest);
    case "metrics":
      return (await import("./metrics.ts")).metricsCommand(rest);
    case "push-relay":
      return (await import("../push_relay/cli.ts")).pushRelayCommand(rest);
    case "status":
      return (await import("./status.ts")).statusCommand(rest);
    case "usage":
      return (await import("./usage.ts")).usageCommand(rest);
    case "cloud":
      return (await import("./cloud.ts")).cloudCommand(rest);
    case "steer":
    case "steers":
      return (await import("./steer.ts")).steerCommand(rest, command === "steers");
    case "chat":
      return (await import("./chat.ts")).chatCommand(rest);
    case "work":
      return (await import("./work.ts")).workCommand(rest);
    case "update":
      return (await import("./update.ts")).updateCommand(rest);
    default:
      return undefined;
  }
}

/** Runs `argv` (without the binary's name) and returns the exit code. */
export async function main(argv: string[]): Promise<number> {
  keepRunningBinary();
  const [command, sub] = argv;
  const rest = argv.slice(1);
  try {
    // Every argument after these is theirs, `--help` too.
    if (command === "mac") return await (await import("./mac_tool.ts")).run(rest);
    if (command === "agent-device") return await (await import("./agent_device.ts")).run(rest);
    if (command === "build-slot") return await (await import("../node/build_slots.ts")).main(rest);
    if (command === "session-host") return (await import("./session_host.ts")).run(rest);
    initFromArgv(argv);
    const help = helpFor(argv);
    if (help !== undefined) {
      process.stdout.write(help);
      return 0;
    }
    if (command === "hub" && sub === "start") return await (await import("../hub/serve/index.ts")).hubStart(argv.slice(2));
    if (command === "agent-mcp") return await (await import("./agent_mcp/index.ts")).agentMcp(rest);
    if (command === "update-finish" && sub !== undefined) return await (await import("../update/finish.ts")).run(sub);
    if (command === "update-hold" && sub !== undefined) return await (await import("../node/hold.ts")).runHook(sub);
    if (command === "update-claude") return await (await import("./update.ts")).runClaude();
    if (command !== undefined) {
      const code = await longRunning(command, rest);
      if (code !== undefined) return code;
    }
    switch (command) {
      case "version":
      case "--version":
      case "-v":
        process.stdout.write(versionLine());
        return 0;
      case undefined:
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(usageText());
        return 0;
      case "pair":
        return emit(await (await import("./pair.ts")).pairCommand(rest));
      case "invite":
        return emit(await (await import("./people.ts")).inviteCommand(rest));
      case "people":
        return emit(await (await import("./people.ts")).peopleCommand(rest));
      case "prompts":
        return emit(await (await import("./prompts.ts")).promptsCommand(rest));
      case "instructions":
        return emit(await (await import("./prompts.ts")).instructionsCommand(rest));
      case "hub":
        if (sub === "key") return emit((await import("./hub_key.ts")).hubKey(argv.slice(2)));
        process.stderr.write(`fleetd: unknown hub command '${sub ?? ""}'\n\n${usageText()}`);
        return 2;
      default:
        process.stderr.write(`fleetd: unknown command '${command}'\n\n${usageText()}`);
        return 2;
    }
  } catch (error) {
    if (!(error instanceof NotImplemented)) throw error;
    process.stderr.write(`fleetd: ${error.message}\n`);
    return 1;
  }
}
