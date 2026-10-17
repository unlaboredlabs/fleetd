import { parseArgs } from "node:util";
import { MachineId, Role, type AgentKeyInfo, type Grant } from "@fleetd/contracts";
import * as Auth from "@fleetd/hub/auth/Auth.ts";
import * as HubDb from "@fleetd/hub/store/HubDb.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { CliResult } from "./cli.ts";

export const HUB_KEY_USAGE = `  hub key create --name <name> --role <read|operate|admin> --machines <'*'|id,id> [--home <dir>]
             create an agent key for the MCP endpoint; prints the key once
  hub key list [--home <dir>]
  hub key revoke <keyId> [--home <dir>]
             takes effect at once, also on a running hub
`;

const ok = (stdout: string, stderr = ""): CliResult => ({ code: 0, stdout, stderr });
const fail = (code: number, message: string): CliResult => ({ code, stdout: "", stderr: `fleetd: ${message}\n` });

const usage = (message: string) => fail(2, `${message}\n\nusage:\n${HUB_KEY_USAGE}`);

const describeGrants = (grants: ReadonlyArray<Grant>) =>
  grants.map((g) => `${g.role}:${g.machines === "*" ? "*" : g.machines.join(",")}`).join(" ");

const row = (info: AgentKeyInfo) =>
  [
    info.keyId,
    info.prefix,
    info.name,
    describeGrants(info.grants),
    info.createdAt,
    info.lastUsedAt ?? "-",
    info.revokedAt ? `revoked ${info.revokedAt}` : "active",
  ].join("\t");

const parseGrant = (role: string | undefined, machines: string | undefined): Grant | string => {
  if (!role || !Schema.is(Role)(role)) return "--role must be read, operate or admin";
  if (!machines) return "--machines is required: '*' or a comma-separated list of machine ids";
  if (machines === "*") return { role, machines: "*" };
  const ids = machines.split(",").map((s) => s.trim());
  const bad = ids.find((id) => !Schema.is(MachineId)(id));
  if (bad !== undefined) return `'${bad}' is not a machine id ([a-z0-9-]{1,32})`;
  return { role, machines: ids.map((id) => MachineId.make(id)) };
};

const withAuth = (home: string | undefined, use: (auth: Auth.Auth["Service"]) => Effect.Effect<CliResult>) =>
  Effect.runSync(
    HubDb.resolveHubHome(home).pipe(
      Effect.flatMap((resolved) =>
        Effect.gen(function* () {
          return yield* use(yield* Auth.Auth);
        }).pipe(
          Effect.provide(Auth.layer.pipe(Layer.provide(HubDb.layer(resolved)))),
        ),
      ),
      Effect.catchTags({ HubHomeError: (error) => Effect.succeed(fail(1, error.message)) }),
    ),
  );

/** `fleetd hub key …`. Opens the hub home's database directly; SQLite WAL makes that safe while the hub runs. */
export const hubKey = (argv: ReadonlyArray<string>): CliResult => {
  const [command, ...rest] = argv;
  let parsed;
  try {
    parsed = parseArgs({
      args: [...rest],
      allowPositionals: true,
      options: {
        home: { type: "string" },
        name: { type: "string" },
        role: { type: "string" },
        machines: { type: "string" },
      },
    });
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;

  switch (command) {
    case "create": {
      if (!values.name) return usage("--name is required");
      const grant = parseGrant(values.role, values.machines);
      if (typeof grant === "string") return usage(grant);
      const name = values.name;
      return withAuth(values.home, (auth) =>
        Effect.map(auth.createKey(name, [grant]), ({ key, info }) =>
          ok(
            `${key}\n`,
            `created ${info.keyId} (${info.prefix}, ${describeGrants(info.grants)}). The key above is shown only once.\n`,
          ),
        ),
      );
    }
    case "list":
      return withAuth(values.home, (auth) =>
        Effect.map(auth.list(), (keys) =>
          ok(["key\tprefix\tname\tgrants\tcreated\tlast used\tstatus", ...keys.map(row)].join("\n") + "\n"),
        ),
      );
    case "revoke": {
      const [keyId] = positionals;
      if (!keyId) return usage("revoke needs a key id (see `fleetd hub key list`)");
      return withAuth(values.home, (auth) =>
        auth.revoke(keyId).pipe(
          Effect.map(() => ok(`revoked ${keyId}\n`)),
          Effect.catchTags({ KeyNotFound: (error) => Effect.succeed(fail(1, error.message)) }),
        ),
      );
    }
    default:
      return usage(command ? `unknown hub key command '${command}'` : "missing hub key command");
  }
};
