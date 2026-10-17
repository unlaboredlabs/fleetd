import { parseArgs } from "node:util";
import { MachineId } from "@fleetd/contracts";
import * as Auth from "@fleetd/hub/auth/Auth.ts";
import * as HubDb from "@fleetd/hub/store/HubDb.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { CliResult } from "./cli.ts";

export const HUB_TOKEN_USAGE = `  hub token create --machine <id> [--home <dir>]
             print a one-time enrollment token (15 min) for \`fleetd node join\`
`;

const fail = (code: number, message: string): CliResult => ({ code, stdout: "", stderr: `fleetd: ${message}\n` });
const usage = (message: string) => fail(2, `${message}\n\nusage:\n${HUB_TOKEN_USAGE}`);

/** `fleetd hub token …`. Writes the hub home's database directly, like `hub key`. */
export const hubToken = (argv: ReadonlyArray<string>): CliResult => {
  const [command, ...rest] = argv;
  let values;
  try {
    ({ values } = parseArgs({ args: [...rest], options: { home: { type: "string" }, machine: { type: "string" } } }));
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }
  if (command !== "create") return usage(command ? `unknown hub token command '${command}'` : "missing hub token command");
  const machine = values.machine;
  if (!machine) return usage("--machine is required");
  if (!Schema.is(MachineId)(machine)) return usage(`'${machine}' is not a machine id ([a-z0-9-]{1,32})`);

  return Effect.runSync(
    HubDb.resolveHubHome(values.home).pipe(
      Effect.flatMap((home) =>
        Effect.gen(function* () {
          const { token, expiresAt } = yield* (yield* Auth.Auth).createEnrollToken(machine);
          return {
            code: 0,
            stdout: `${token}\n`,
            stderr:
              `one-time token for ${machine}, valid until ${expiresAt}. On ${machine}, run:\n` +
              `  fleetd node join --hub <hub url> --token <token> --machine ${machine} --t3-home <t3 home> --t3-url <t3 url>\n`,
          };
        }).pipe(Effect.provide(Auth.layer.pipe(Layer.provide(HubDb.layer(home))))),
      ),
      Effect.catchTags({ HubHomeError: (error) => Effect.succeed(fail(1, error.message)) }),
    ),
  );
};
