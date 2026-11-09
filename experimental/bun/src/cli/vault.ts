// `fleetd vault …` on the hub (vault-design §2): the vault's root key, where it's kept, and its recovery code. It reads
// the key file beside the hub's home and the hub's database directly (WAL makes that safe while the hub runs); a
// passphrase or a recovery code is read from stdin, never from the command line, so it stays out of shell history.
import { existsSync } from "node:fs";
import { readLine } from "./tty.ts";
import { ArgError, parse } from "./args.ts";
import { resolveHome } from "./common.ts";
import { type CliResult, err, ok } from "./result.ts";
import { openHub } from "./store.ts";
import { VAULT_USAGE } from "./usages.ts";
import { checkOpens } from "../hub/vault/crypto.ts";
import { keyDir, keyFromRecoveryCode, type KeyMode, recoveryCode, VaultKeyError, VaultKeys } from "../hub/vault/keys.ts";


const fail = (code: number, message: string) => err(code, `fleetd: ${message}\n`);
const RESTART = "Restart the hub so it reads the key again: systemctl --user restart fleetd-hub (or fleetd hub start).";

async function secretLine(prompt: string): Promise<string | undefined> {
  if (process.stdin.isTTY) process.stderr.write(prompt);
  const line = await readLine();
  return line?.replace(/\r?\n$/, "");
}

/** The key set as the hub would load it; a passphrase-kept one is opened with a passphrase from stdin. */
async function loaded(home: string): Promise<VaultKeys> {
  const keys = new VaultKeys(keyDir(home));
  await keys.load(false);
  if (keys.mode === "passphrase") {
    const pass = await secretLine("Vault passphrase: ");
    if (pass === undefined || !keys.unlock(pass)) throw new VaultKeyError("vault_locked", "that passphrase doesn't open the vault key");
  }
  return keys;
}

export async function vaultCommand(argv: string[]): Promise<CliResult> {
  const [command, ...rest] = argv;
  const args = parse(rest, { options: { home: "str", store: "str", force: "bool" }, positionals: false });
  if (args instanceof ArgError) return fail(2, `${args.message}\n\nusage:\n${VAULT_USAGE}`);
  const home = resolveHome(args.str("home"));
  try {
    switch (command) {
      case "key": {
        const mode = args.str("store") as KeyMode | undefined;
        if (mode !== "file" && mode !== "keyring" && mode !== "passphrase") return fail(2, `--store must be file, keyring or passphrase\n\nusage:\n${VAULT_USAGE}`);
        const keys = await loaded(home);
        let pass: string | undefined;
        if (mode === "passphrase") {
          pass = await secretLine("New passphrase (12 characters or more): ");
          const again = await secretLine("Again: ");
          if (pass === undefined || pass !== again) return fail(1, "the two passphrases differ");
        }
        await keys.store(mode, pass);
        return ok(`The vault key is now kept ${mode === "file" ? `in ${keys.path}` : mode === "keyring" ? "in this machine's keychain" : "in a passphrase-locked file"}. ${RESTART}\n`);
      }
      case "recovery-code": {
        const keys = await loaded(home);
        const code = recoveryCode(keys.active().key);
        const db = openHub(home);
        try {
          db.conn.query("INSERT INTO vault_settings (key, value) VALUES ('recovery_saved_ms', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(Date.now()));
        } finally {
          db.conn.close();
        }
        return ok(`${code}\n\nKeep this somewhere other than the hub. With a copy of the hub's database, it opens every item in the vault.\n`);
      }
      case "restore-key": {
        const line = await secretLine("Recovery code: ");
        const key = line === undefined ? undefined : keyFromRecoveryCode(line);
        if (!key) return fail(1, "that isn't a recovery code: check it and type it again");
        const db = openHub(home);
        let hit: { key_id: string; created_ms: number } | undefined;
        try {
          const rows = db.conn.query<{ key_id: string; created_ms: number; check_blob: Uint8Array }, []>("SELECT key_id, created_ms, check_blob FROM vault_keys").all();
          hit = rows.find((r) => checkOpens(key, r.key_id, new Uint8Array(r.check_blob)));
        } finally {
          db.conn.close();
        }
        if (!hit) return fail(1, "that code isn't the key this vault was sealed with");
        const keys = new VaultKeys(keyDir(home));
        if (existsSync(keys.path) && !args.flag("force")) {
          try {
            await keys.load(false);
            if (!keys.locked && keys.key(hit.key_id)) return ok(`The vault key ${hit.key_id} is already in place.\n`);
          } catch {}
          return fail(1, `${keys.path} holds another key: move it aside or run with --force to replace it`);
        }
        await keys.restore(hit.key_id, key, hit.created_ms);
        key.fill(0);
        return ok(`The vault key ${hit.key_id} is back in ${keys.path}. ${RESTART}\n`);
      }
      default:
        return fail(2, `unknown vault command '${command ?? ""}'\n\nusage:\n${VAULT_USAGE}`);
    }
  } catch (e) {
    if (e instanceof VaultKeyError) return fail(1, e.message);
    throw e;
  }
}
