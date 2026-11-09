// `fleetd node join|run|grants|restart|flush`: the CLI parses the flags and refuses a
// usage mistake in the Rust CLI's words; the node itself (src/node) runs join, run and flush; grants is its to
// port, and `restart` is the update service's (src/update).
import { NotImplemented } from "../shared/errors.ts";
import { ArgError, parse } from "./args.ts";
import { ioMessage } from "./common.ts";
import { currentExe } from "./setup/shared.ts";
import { NODE_USAGE } from "./usages.ts";
import { readFileSync } from "node:fs";

function usage(message: string): number {
  process.stderr.write(`fleetd: ${message}\n\nusage:\n${NODE_USAGE}`);
  return 2;
}

/** `--token-file <file|->`: the token, trimmed; `-` is stdin (node/mod.rs `read_token_file`). */
async function readTokenFile(file: string): Promise<string> {
  try {
    return (file === "-" ? await Bun.stdin.text() : readFileSync(file, "utf8")).trim();
  } catch (error) {
    throw new Error(ioMessage(error));
  }
}

const SECONDS = /^\+?[0-9]+$/;

/** Waits until process `pid` has ended (an hour at most), then long enough for the node to keep and send its result. */
async function restartAfter(pid: number, answerWaitMs: number) {
  const started = Date.now();
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  while (alive() && Date.now() - started < 3_600_000) await Bun.sleep(100);
  await Bun.sleep(answerWaitMs);
}

export async function nodeCommand(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const v = parse(rest, {
    options: {
      home: "str",
      hub: "str",
      token: "str",
      "token-file": "str",
      "enroll-only": "bool",
      machine: "str",
      "claude-config-dir": "str",
      mac: "bool",
      wait: "str",
      ask: "str",
      after: "str",
    },
    positionals: false,
  });
  if (v instanceof ArgError) return usage(v.message);
  const node = () => import("../node/index.ts");
  switch (command) {
    case "join": {
      // First, before the token is read from stdin: the node, run again, reads it in its turn.
      (await node()).ownTmpOrExec(v.str("home"));
      let token = v.str("token");
      const file = v.str("token-file");
      if (token === undefined && file !== undefined) {
        try {
          token = await readTokenFile(file);
        } catch (error) {
          return usage(`cannot read --token-file: ${(error as Error).message}`);
        }
      }
      for (const [name, value] of [["hub", v.str("hub")], ["token", token], ["machine", v.str("machine")]] as const) {
        if (!value) return usage(`--${name} is required`);
      }
      const home = v.str("home");
      const dir = v.str("claude-config-dir");
      return (await node()).join_({
        hub: v.str("hub")!,
        token: token!,
        machine: v.str("machine")!,
        ...(home === undefined ? {} : { home }),
        enrollOnly: v.flag("enroll-only"),
        ...(dir ? { claudeConfigDir: dir } : {}),
        mac: v.flag("mac"),
      });
    }
    case "run": {
      const home = v.str("home");
      (await node()).ownTmpOrExec(home);
      return (await node()).run(home === undefined ? {} : { home });
    }
    case "flush": {
      const wait = v.str("wait");
      if (wait !== undefined && !SECONDS.test(wait)) return usage("--wait takes a number of seconds");
      const { flush } = await import("../node/flush.ts");
      const { defaultNodeHome } = await import("../node/config.ts");
      console.log(await flush(v.str("home") ?? defaultNodeHome(), (wait === undefined ? 50 : Number(wait)) * 1000));
      return 0;
    }
    case "grants": {
      const ask = v.str("ask");
      if (ask !== undefined && ask !== "accessibility" && ask !== "screen_recording") {
        return usage("--ask takes accessibility or screen_recording");
      }
      const wait = v.str("wait");
      if (ask !== undefined && wait !== undefined && !SECONDS.test(wait)) return usage("--wait takes a number of seconds");
      const { grantsCommand } = await import("../node/agents_mac/grants.ts");
      const { defaultNodeHome } = await import("../node/config.ts");
      return grantsCommand({ ...(ask !== undefined ? { ask } : {}), ...(wait !== undefined ? { wait } : {}), home: v.str("home") ?? defaultNodeHome() });
    }
    case "restart": {
      const after = v.str("after");
      if (after !== undefined && !/^[+-]?[0-9]+$/.test(after)) return usage("--after takes a process id");
      const { restart, services, isHubService } = await import("../update/service.ts");
      const { ANSWER_WAIT_MS } = await import("../update/finish.ts");
      let exe: string | undefined;
      try {
        exe = currentExe();
      } catch {}
      const service = exe === undefined ? undefined : services(exe).find((s) => !isHubService(s));
      if (service === undefined) {
        process.stderr.write("fleetd: no node service of this fleetd here. Fix: fleetd init --join sets one up\n");
        return 1;
      }
      if (after !== undefined) await restartAfter(Number(after), ANSWER_WAIT_MS);
      try {
        restart(service);
      } catch (error) {
        process.stderr.write(
          `fleetd: ${(error as Error).message}. Fix: log in as this user at the machine's screen, then run fleetd node restart again\n`,
        );
        return 1;
      }
      process.stdout.write(`restarted ${service.name}\n`);
      return 0;
    }
    case undefined:
      return usage("missing node command");
    default:
      return usage(`unknown node command '${command}'`);
  }
}
