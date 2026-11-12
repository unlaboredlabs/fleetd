// `fleetd export` and `fleetd import` on the hub machine: a hub's data as one file, and that file into a fresh hub
// (hub/transfer). Both read and write the hub's home directly. The passphrase the secrets travel under comes from the
// terminal without showing, a file or stdin (`--passphrase-file`), or FLEETD_EXPORT_PASSPHRASE: never the command line,
// and nothing here prints it.
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TransferError } from "../hub/transfer/format.ts";
import { boxKeyAt, exportHub, type ExportSecrets } from "../hub/transfer/export.ts";
import { checkExport, exportKey, importHub, type TargetKeys } from "../hub/transfer/import.ts";
import { PASSPHRASE_MIN } from "../hub/transfer/seal.ts";
import { keyDir, VaultKeyError, VaultKeys } from "../hub/vault/keys.ts";
import { HubDb } from "../hub/store/db.ts";
import { loadOrCreateBoxKey, publicKeyOf } from "../shared/sealed_box.ts";
import { VERSION } from "../shared/version.ts";
import { ArgError, type Parsed, parse } from "./args.ts";
import { isLiveHubHome, liveHubRefusal, resolveHome } from "./common.ts";
import { type CliResult, err, ok } from "./result.ts";
import { processesHolding } from "./setup/shared.ts";
import { readHidden } from "./tty.ts";
import { EXPORT_USAGE } from "./usages.ts";

export const PASSPHRASE_ENV = "FLEETD_EXPORT_PASSPHRASE";
const VAULT_PASSPHRASE_ENV = "FLEETD_VAULT_PASSPHRASE";

const fail = (code: number, message: string) => err(code, `fleetd: ${message}\n`);
const usage = (message: string) => fail(2, `${message}\n\nusage:\n${EXPORT_USAGE}`);
/** `refused` and `newer` are refusals (3): the file and the hub are fine, the pair doesn't fit. The rest failed (1). */
const transferFailure = (e: TransferError) => fail(e.reason === "refused" || e.reason === "newer" ? 3 : 1, e.message);

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

function size(bytes: number): string {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let n = bytes;
  let unit = 0;
  while (n >= 1000 && unit < units.length - 1) {
    n /= 1000;
    unit++;
  }
  return `${unit === 0 || n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[unit]}`;
}

const filesLine = (files: { area: string; files: number; bytes: number }[]) =>
  files
    .filter((f) => f.files > 0)
    .map((f) => `${plural(f.files, "file")} of ${f.area} (${size(f.bytes)})`)
    .join(", ") || "none";

class NoPassphrase extends Error {}

/** The export's passphrase, from where the person keeps it. `twice`: a new one, typed again when it is typed. */
async function passphrase(args: Parsed, twice: boolean): Promise<string> {
  const file = args.str("passphrase-file");
  let pass: string | undefined;
  if (file !== undefined) {
    let text: string;
    try {
      text = file === "-" ? await Bun.stdin.text() : readFileSync(file, "utf8");
    } catch (e) {
      throw new NoPassphrase(`cannot read --passphrase-file: ${(e as Error).message}`);
    }
    pass = text.split("\n")[0]!.replace(/\r$/, "");
  } else if (process.env[PASSPHRASE_ENV]) pass = process.env[PASSPHRASE_ENV];
  else if (process.stdin.isTTY) {
    pass = await readHidden(twice ? `Passphrase for the export's secrets (${PASSPHRASE_MIN} characters or more): ` : "The export's passphrase: ");
    if (pass !== undefined && twice && (await readHidden("Again: ")) !== pass) throw new NoPassphrase("The two passphrases differ.");
  } else {
    throw new NoPassphrase(`No passphrase: type it in a terminal, or give it with --passphrase-file <file|-> or in ${PASSPHRASE_ENV}; or leave the secrets out with --no-secrets.`);
  }
  if (pass === undefined) throw new NoPassphrase("Cancelled.");
  if (twice && [...pass].length < PASSPHRASE_MIN) throw new NoPassphrase(`The passphrase is ${PASSPHRASE_MIN} characters or more.`);
  return pass;
}

/** The vault's key set as the hub loads it; one kept under a passphrase is opened with it (asked, or FLEETD_VAULT_PASSPHRASE). */
async function vaultKeys(home: string, create: boolean): Promise<VaultKeys> {
  const keys = new VaultKeys(keyDir(home));
  await keys.load(create);
  if (keys.mode === "passphrase") {
    const pass = process.env[VAULT_PASSPHRASE_ENV] || (await readHidden("This hub's vault passphrase: "));
    if (pass === undefined || !keys.unlock(pass)) throw new VaultKeyError("vault_locked", "That passphrase doesn't open this hub's vault key.");
  }
  return keys;
}

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

export async function exportCommand(argv: string[]): Promise<CliResult> {
  const args = parse(argv, { options: { home: "str", out: "str", "no-secrets": "bool", "passphrase-file": "str" }, positionals: false });
  if (args instanceof ArgError) return usage(args.message);
  const home = resolveHome(args.str("home"));
  // The file holds everything the hub knows, its secrets under a passphrase the caller picks.
  if (isLiveHubHome(home)) return fail(3, "Inside an agent's session the fleetd CLI doesn't export the live hub. For a throwaway hub, set FLEETD_HOME.");
  if (!existsSync(join(home, "hub.sqlite"))) return fail(1, `There is no hub at ${home}.`);
  const out = resolve(args.str("out") ?? `fleetd-export-${stamp(Date.now())}.tar`);
  if (existsSync(out)) return fail(1, `${out} is already there: name another file with --out.`);

  let secrets: ExportSecrets | undefined;
  try {
    if (!args.flag("no-secrets")) {
      const pass = await passphrase(args, true);
      const db = HubDb.openReadonly(home);
      let items: boolean;
      try {
        items = db.all("SELECT 1 FROM sqlite_master WHERE name = 'vault_items'").length > 0 && db.all("SELECT 1 FROM vault_items LIMIT 1").length > 0;
      } finally {
        db.close();
      }
      // A hub with no vault items needs no vault key; one whose key is missing exports without them, and says so.
      let keys: VaultKeys | undefined;
      if (items) {
        try {
          keys = await vaultKeys(home, false);
        } catch (e) {
          if (!(e instanceof VaultKeyError) || e.reason === "vault_locked") throw e;
        }
      }
      secrets = { passphrase: pass, box: boxKeyAt(home), root: (id) => keys?.key(id) };
    }
  } catch (e) {
    if (e instanceof NoPassphrase) return e.message.startsWith("No passphrase") ? usage(e.message) : fail(1, e.message);
    if (e instanceof VaultKeyError) return fail(1, e.message);
    throw e;
  }

  const part = `${out}.part`;
  const file = await open(part, "wx", 0o600).catch((e: Error) => e);
  if (file instanceof Error) return fail(1, `cannot write ${part}: ${file.message}`);
  try {
    const done = await exportHub({
      home,
      fleetd: VERSION,
      now: Date.now,
      write: async (chunk) => {
        for (let at = 0; at < chunk.length; ) at += (await file.write(chunk, at)).bytesWritten;
      },
      ...(secrets ? { secrets } : {}),
    });
    await file.sync();
    await file.close();
    renameSync(part, out);
    const lines = [
      `Exported the hub at ${home} to ${out} (${size(statSync(out).size)}).`,
      `  data      ${plural(done.rows, "row")} in ${plural(done.tables, "table")}`,
      `  files     ${filesLine(done.files)}`,
      `  secrets   ${done.secrets ? "sealed under the passphrase; the file opens them only with it, so keep it" : "left out (--no-secrets)"}`,
      ...(done.skipped.length > 0 ? ["  left out:", ...done.skipped.map((s) => `    ${s}`)] : []),
      "",
      "Machines, their keys and everyone's device sign-ins aren't in it: after fleetd import, machines join",
      "again and people sign in again. Load it into a fresh hub with:",
      `  fleetd import ${out}`,
      "",
    ];
    return ok(lines.join("\n"));
  } catch (e) {
    await file.close().catch(() => {});
    rmSync(part, { force: true });
    if (e instanceof TransferError) return transferFailure(e);
    throw e;
  }
}

export async function importCommand(argv: string[]): Promise<CliResult> {
  const args = parse(argv, { options: { home: "str", "no-secrets": "bool", "passphrase-file": "str" }, positionals: true });
  if (args instanceof ArgError) return usage(args.message);
  const [file, ...more] = args.positionals;
  if (file === undefined || more.length > 0) return usage("import takes one file");
  const home = resolveHome(args.str("home"));
  if (isLiveHubHome(home)) return fail(1, liveHubRefusal("Importing"));
  if (!existsSync(file)) return fail(1, `There is no file ${file}.`);
  try {
    const checked = await checkExport(file);
    const db = join(home, "hub.sqlite");
    if (existsSync(db) && processesHolding(realpathSync(db)).length > 0) {
      return fail(3, `A hub is running on ${home}. Stop it (systemctl --user stop fleetd-hub, or on a Mac launchctl bootout gui/$(id -u)/sh.fleetd.hub), then import. Nothing was changed.`);
    }
    let key: Uint8Array | undefined;
    if (checked.header.secrets && !args.flag("no-secrets")) {
      key = exportKey(checked, await passphrase(args, false)) ?? undefined;
      if (!key) return fail(1, "That isn't the passphrase this export was written with. Nothing was changed; to load it without its secrets, pass --no-secrets.");
    }
    const target = async (): Promise<TargetKeys> => {
      const root = (await vaultKeys(home, true)).active();
      return { boxPublic: publicKeyOf(loadOrCreateBoxKey(home)), root: { id: root.id, key: root.key } };
    };
    const done = await importHub({ file, home, checked, ...(key ? { secrets: { key, target } } : {}) });
    key?.fill(0);
    const others = done.people.filter((p) => p.role !== "owner");
    const lines = [
      `Loaded ${file} (written by fleetd ${checked.header.fleetd}, ${checked.header.createdAt}) into the hub at ${home}.`,
      `  data      ${plural(done.rows, "row")} in ${plural(done.tables, "table")}`,
      `  files     ${filesLine(done.files)}`,
      `  secrets   ${done.secrets ? "loaded, sealed to this hub's own keys" : "not loaded"}`,
      ...(done.skipped.length > 0 ? ["  skipped:", ...done.skipped.map((s) => `    ${s}`)] : []),
      "",
      "Start the hub (systemctl --user start fleetd-hub; on a Mac, launchctl bootstrap gui/$(id -u)",
      "~/Library/LaunchAgents/sh.fleetd.hub.plist). Then:",
      ...(done.machines.length > 0
        ? [
            "  Machines aren't carried. Join each one again under its id, so its projects find it: run this on",
            "  the hub machine, then the command it prints on that machine (with --rejoin when this hub",
            "  answers at the old hub's address).",
            ...done.machines.map((m) => `    fleetd pair --worker ${m.machineId}${m.name && m.name !== m.machineId ? `    # ${m.name}` : ""}`),
          ]
        : []),
      "  Keys and device sign-ins aren't carried. Sign in again with fleetd pair" + (others.length > 0 ? "; everyone else with an invite:" : "."),
      ...others.map((p) => `    fleetd invite --person ${p.personId}    # ${p.name}, ${p.role}`),
      "",
    ];
    return ok(lines.join("\n"));
  } catch (e) {
    if (e instanceof NoPassphrase) return e.message.startsWith("No passphrase") ? usage(e.message) : fail(1, e.message);
    if (e instanceof VaultKeyError) return fail(1, `${e.message} Nothing was changed.`);
    if (e instanceof TransferError) return transferFailure(e);
    throw e;
  }
}
