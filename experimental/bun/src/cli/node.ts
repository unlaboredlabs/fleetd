// `fleetd node join|run|grants|restart|flush` (crates/fleetd/src/cli/node.rs): the CLI parses the flags and refuses a
// usage mistake in the Rust CLI's words; the node itself (src/node) runs join and run; flush and grants are its to
// port, and `restart` is the update service's (src/update).
import { NotImplemented } from "../shared/errors.ts";
import { ArgError, parse } from "./args.ts";
import { ioMessage } from "./common.ts";
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
      });
    }
    case "run": {
      const home = v.str("home");
      return (await node()).run(home === undefined ? {} : { home });
    }
    case "flush": {
      const wait = v.str("wait");
      if (wait !== undefined && !SECONDS.test(wait)) return usage("--wait takes a number of seconds");
      throw new NotImplemented("src/node/flush: fleetd node flush");
    }
    case "grants": {
      const ask = v.str("ask");
      if (ask !== undefined && ask !== "accessibility" && ask !== "screen_recording") {
        return usage("--ask takes accessibility or screen_recording");
      }
      const wait = v.str("wait");
      if (ask !== undefined && wait !== undefined && !SECONDS.test(wait)) return usage("--wait takes a number of seconds");
      throw new NotImplemented("src/node/agents_mac: fleetd node grants");
    }
    case "restart": {
      const after = v.str("after");
      if (after !== undefined && !/^[+-]?[0-9]+$/.test(after)) return usage("--after takes a process id");
      throw new NotImplemented("src/update/service: fleetd node restart");
    }
    case undefined:
      return usage("missing node command");
    default:
      return usage(`unknown node command '${command}'`);
  }
}
