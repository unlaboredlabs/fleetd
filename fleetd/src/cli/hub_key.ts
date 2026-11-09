// `fleetd hub key …` (crates/fleetd/src/cli/hub_key.rs): it opens the hub home's database directly; SQLite WAL makes
// that safe while the hub runs.
import { closeSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Grant, Role } from "../shared/contracts.ts";
import { ArgError, parse } from "./args.ts";
import { type CliResult, err, ok } from "./result.ts";
import { isMachineId, newPrivateFile, resolveHome } from "./common.ts";
import { createKey, type KeyInfo, listKeys, openHub, releaseClaims, revokeKey } from "./store.ts";
import { HUB_KEY_USAGE } from "./usages.ts";
export { HUB_KEY_USAGE };


const fail = (code: number, message: string) => err(code, `fleetd: ${message}\n`);
const keyUsage = (message: string) => fail(2, `${message}\n\nusage:\n${HUB_KEY_USAGE}`);

/** `[A-Za-z0-9_-]{1,40}`. */
const isFileName = (name: string) => /^[A-Za-z0-9_-]{1,40}$/.test(name);

export const describeGrants = (grants: Grant[]) =>
  grants.map((g) => `${g.role}:${g.machines === "*" ? "*" : g.machines.join(",")}`).join(" ");

function row(info: KeyInfo): string {
  return [
    info.keyId,
    info.prefix,
    info.kind === "human" ? `${info.name} (human)` : info.name,
    describeGrants(info.grants),
    info.createdAt,
    info.lastUsedAt ?? "-",
    info.revokedAt === undefined ? "active" : `revoked ${info.revokedAt}`,
  ].join("\t");
}

export function parseGrant(role: string | undefined, machines: string | undefined): Grant {
  if (role !== "read" && role !== "operate" && role !== "admin") throw new ArgError("--role must be read, operate or admin");
  if (!machines) throw new ArgError("--machines is required: '*' or a comma-separated list of machine ids");
  if (machines === "*") return { role: role as Role, machines: "*" };
  const ids = machines.split(",").map((id) => id.trim());
  for (const id of ids) if (!isMachineId(id)) throw new ArgError(`'${id}' is not a machine id ([a-z0-9-]{1,32})`);
  return { role: role as Role, machines: ids } as Grant;
}

function withHub(home: string | undefined, use: (db: ReturnType<typeof openHub>) => CliResult): CliResult {
  let db;
  try {
    db = openHub(resolveHome(home));
  } catch (error) {
    return fail(1, (error as Error).message);
  }
  try {
    return use(db);
  } finally {
    db.conn.close();
  }
}

/** `fleetd hub key …`, on the hub at `home`, else this machine's. */
export function hubKey(argv: string[], home?: string): CliResult {
  const [command, ...rest] = argv;
  const v = parse(rest, {
    options: { name: "str", role: "str", machines: "str", human: "bool", agent: "str", out: "str" },
    positionals: true,
  });
  if (v instanceof ArgError) return keyUsage(v.message);
  switch (command) {
    case "create": {
      const agent = v.str("agent") || undefined;
      if (agent !== undefined && (v.flag("human") || v.has("name") || v.has("role"))) {
        return keyUsage("--agent names the key and sets its role; leave out --name, --role and --human");
      }
      const name = agent ?? (v.str("name") || undefined);
      if (!name) return keyUsage("--name is required");
      if (agent !== undefined && !isFileName(name)) {
        return keyUsage("--agent is a name of letters, digits, '-' and '_' (at most 40)");
      }
      const human = v.flag("human");
      let grant: Grant;
      try {
        grant =
          human || agent !== undefined
            ? parseGrant(v.str("role") ?? "operate", v.str("machines") ?? "*")
            : parseGrant(v.str("role"), v.str("machines"));
      } catch (error) {
        return keyUsage((error as Error).message);
      }
      const out = v.str("out") || (agent !== undefined ? join(resolveHome(home), "keys", `${agent}.key`) : undefined);
      // Made before the key, so the key is never minted for a file that can't take it.
      let fd: number | undefined;
      if (out !== undefined) {
        try {
          fd = newPrivateFile(out);
        } catch (error) {
          return fail(1, (error as Error).message);
        }
      }
      const created = withHub(home, (db) => {
        let made;
        try {
          made = createKey(db, name, [grant], human ? "human" : "agent");
        } catch (error) {
          return fail(1, (error as Error).message);
        }
        if (fd !== undefined && out !== undefined) {
          try {
            writeSync(fd, `${made.key}\n`);
          } catch (error) {
            return fail(1, `cannot write ${out}: ${(error as Error).message}`);
          }
          return ok(`${out}\n`);
        }
        return {
          code: 0,
          stdout: `${made.key}\n`,
          stderr: `created ${made.info.keyId} (${made.info.prefix}, ${describeGrants(made.info.grants)}${human ? ", human" : ""}). The key above is shown only once.\n`,
        };
      });
      if (fd !== undefined) closeSync(fd);
      if (created.code !== 0 && out !== undefined) rmSync(out, { force: true });
      return created;
    }
    case "list":
      return withHub(home, (db) => {
        const lines = ["key\tprefix\tname\tgrants\tcreated\tlast used\tstatus", ...listKeys(db).map(row)];
        return ok(`${lines.join("\n")}\n`);
      });
    case "revoke": {
      const keyId = v.positionals[0];
      if (!keyId) return keyUsage("revoke needs a key id (see `fleetd hub key list`)");
      return withHub(home, (db) => {
        let links: number;
        try {
          links = revokeKey(db, keyId);
        } catch (error) {
          return fail(1, (error as Error).message);
        }
        const revoked =
          links === 0
            ? `revoked ${keyId}`
            : links === 1
              ? `revoked ${keyId} and its hub link`
              : `revoked ${keyId} and its ${links} hub links`;
        try {
          const released = releaseClaims(db, keyId, "its key was revoked");
          return ok(released.length === 0 ? `${revoked}\n` : `${revoked}; released ${released.join(", ")}\n`);
        } catch (error) {
          return fail(1, `${revoked}, but its claims were not released: ${(error as Error).message}`);
        }
      });
    }
    case undefined:
      return keyUsage("missing hub key command");
    default:
      return keyUsage(`unknown hub key command '${command}'`);
  }
}
