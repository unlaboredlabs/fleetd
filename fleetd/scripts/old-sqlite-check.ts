// `bun scripts/old-sqlite-check.ts`: every hub migration, in order, from an empty database on the oldest SQLite fleetd
// supports (OLDEST_SQLITE, src/hub/store/migrations.ts). On macOS Bun's SQLite is the system's, which can be years
// older than the one Bun links on Linux, so a migration that runs here can fail a Mac hub's start.
//
// Builds that version's sqlite3 shell from sqlite.org's amalgamation (pinned by SHA-256, with FTS5 and JSON1 as macOS's
// has them) into $FLEETD_OLD_SQLITE_DIR (default: a directory under the temp dir), once. Runs each migration in a
// transaction of its own, as the hub does, then compares the schema with the one this Bun's SQLite makes. Exits 1
// naming the first migration that needs a newer SQLite, or each schema difference. CI's fleetd job runs it.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS } from "../src/gen/migrations.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { OLDEST_SQLITE } from "../src/hub/store/migrations.ts";

/** sqlite.org's amalgamation of OLDEST_SQLITE: its file name says the version (3.37.2 is 3370200). */
const AMALGAMATION = {
  url: "https://www.sqlite.org/2022/sqlite-amalgamation-3370200.zip",
  sha256: "cb25df0fb90b77be6660f6ace641bbea88f3d0441110d394ce418f35f7561bb0",
};

const dir = process.env.FLEETD_OLD_SQLITE_DIR ?? join(tmpdir(), `fleetd-sqlite-${OLDEST_SQLITE}`);
const shell = join(dir, "sqlite3");
const fail = (why: string): never => {
  console.error(`old-sqlite-check: ${why}`);
  process.exit(1);
};
const run = (cmd: string[], stdin?: string) => {
  const r = Bun.spawnSync(cmd, { cwd: dir, stdin: stdin === undefined ? "ignore" : Buffer.from(stdin) });
  return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString().trim() };
};

if (!existsSync(shell)) {
  mkdirSync(dir, { recursive: true });
  const zip = await fetch(AMALGAMATION.url).then((r) => (r.ok ? r.arrayBuffer() : fail(`${AMALGAMATION.url}: ${r.status}`)));
  const sum = new Bun.CryptoHasher("sha256").update(zip).digest("hex");
  if (sum !== AMALGAMATION.sha256) fail(`${AMALGAMATION.url} has SHA-256 ${sum}, not ${AMALGAMATION.sha256}`);
  await Bun.write(join(dir, "amalgamation.zip"), zip);
  const unzip = run(["unzip", "-o", "-j", "-q", "amalgamation.zip"]);
  if (!unzip.ok) fail(`unzip: ${unzip.err}`);
  const cc = run(["cc", "-O0", "-DSQLITE_ENABLE_FTS5", "-DSQLITE_ENABLE_JSON1", "-o", "sqlite3.part", "shell.c", "sqlite3.c", "-lpthread", "-lm", "-ldl"]);
  if (!cc.ok) fail(`cc: ${cc.err}`);
  rmSync(join(dir, "amalgamation.zip"));
  run(["mv", "sqlite3.part", "sqlite3"]);
}
const version = run([shell, "--version"]).out.split(" ")[0];
if (version !== OLDEST_SQLITE) fail(`${shell} is SQLite ${version}, not ${OLDEST_SQLITE}`);

const scratch = mkdtempSync(join(tmpdir(), "fleetd-old-sqlite-"));
const problems: string[] = [];
try {
  const db = join(scratch, "hub.sqlite");
  for (const m of MIGRATIONS) {
    const r = run([shell, "-bail", db], `BEGIN IMMEDIATE;\n${m.sql}\nCOMMIT;\n`);
    if (r.ok) continue;
    problems.push(`migration ${m.name} needs a newer SQLite than ${OLDEST_SQLITE}, the oldest fleetd supports: ${r.err}`);
    break;
  }
  if (problems.length === 0) {
    // The runner's own migrations_applied aside: the hub makes it, not a migration.
    const query = "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != 'migrations_applied' ORDER BY type, name";
    const fold = (rows: { type: string; name: string; sql: string | null }[]) =>
      new Map(rows.map((r) => [`${r.type} ${r.name}`, (r.sql ?? "").replace(/\s+/g, " ").trim()]));
    const old = fold(JSON.parse(run([shell, "-json", db, query]).out || "[]"));
    const fresh = HubDb.memory();
    const now = fold(fresh.conn.query(query).all() as { type: string; name: string; sql: string | null }[]);
    fresh.conn.close();
    for (const k of new Set([...old.keys(), ...now.keys()])) {
      if (old.get(k) !== now.get(k)) problems.push(`${k} differs on SQLite ${OLDEST_SQLITE}:\n  ${old.get(k)}\n  ${now.get(k)}`);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
if (problems.length > 0) fail(problems.join("\n"));
console.log(`old-sqlite-check: ${MIGRATIONS.length} migrations run from empty on SQLite ${OLDEST_SQLITE}, same schema`);
