// `fleetd export` and `fleetd import` as a person runs them (cli/transfer.ts), on throwaway hubs: where the passphrase
// comes from, what each prints, and the exit code a script reads for each refusal. Nothing prints the passphrase.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportCommand, importCommand, PASSPHRASE_ENV } from "../src/cli/transfer.ts";
import { people } from "../src/hub/people/store.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { loadOrCreateBoxKey, publicKeyOf, seal } from "../src/shared/sealed_box.ts";
import type { ProjectRef, ProjectSummary } from "../src/shared/contracts.ts";
import { AT, open, type Opened, PASS, place, type Place, rewritten, stateOf } from "./transfer-kit.ts";

const M = "devbox";
const PROJECT: ProjectRef = { machineId: M, projectId: "p1" };
const ISO = new Date(AT).toISOString();
const SECRET = "canary-password-Qq11";

const places: Place[] = [];
const opened: Opened[] = [];
const newPlace = () => {
  const p = place();
  places.push(p);
  return p;
};
const start = async (p: Place) => {
  const k = await open(p);
  opened.push(k);
  return k;
};
/** A hub that was set up and started once, stopped as import wants it. */
async function fresh(): Promise<Place> {
  const p = newPlace();
  (await open(p)).close();
  return p;
}
afterEach(() => {
  delete process.env[PASSPHRASE_ENV];
  for (const k of opened.splice(0)) k.close();
  for (const p of places.splice(0)) p.done();
});

/** A running hub with a machine, a project, a second person, a decision and a login in its vault. */
async function source() {
  const p = newPlace();
  const k = await start(p);
  const me = k.device().caller;
  const bo = people(k.hub).create("Bo", "admin");
  store(k.hub).machineUpsert({ machineId: M, name: "Dev box", nodeVersion: "1", status: "online", lastSeenAt: ISO } as never, "node-pub-key");
  store(k.hub).projectsUpsertMany(M, [
    { ...PROJECT, title: "Shop", workspaceRoot: "/srv/shop", lastActivityAt: ISO, threads: { failed: 0, idle: 0, running: 0, waiting: 0 } } as unknown as ProjectSummary,
  ]);
  await k.call(me, "decisions_record", { key: "db.engine", scope: { kind: "project", projectRef: PROJECT }, value: "Postgres for orders" });
  const sealed = Buffer.from(seal(publicKeyOf(loadOrCreateBoxKey(p.home)), Buffer.from(JSON.stringify({ username: "ada", password: SECRET })))).toString("base64");
  const login = await k.call<{ item: { itemId: string } }>(me, "vault_save", { kind: "login", scope: "person", label: "Shop", sites: ["shop.example"], sealed });
  return { p, k, bo, login };
}

/** `source`, exported with its secrets under PASS. */
async function exported() {
  const from = await source();
  process.env[PASSPHRASE_ENV] = PASS;
  const done = await exportCommand(["--home", from.p.home, "--out", from.p.file]);
  delete process.env[PASSPHRASE_ENV];
  return { ...from, done };
}

describe("fleetd export, then fleetd import", () => {
  test("the passphrase comes from the environment or a file, and neither command prints it", async () => {
    const { p: from, bo, login, done } = await exported();
    expect(done.code).toBe(0);
    expect(done.stdout).toStartWith(`Exported the hub at ${from.home} to ${from.file} (`);
    expect(done.stdout).toContain("sealed under the passphrase");
    expect(done.stdout).toContain(`fleetd import ${from.file}`);
    expect(statSync(from.file).mode & 0o777).toBe(0o600);
    expect(readdirSync(from.dir).filter((n) => n.endsWith(".part"))).toEqual([]);

    const to = await fresh();
    const passFile = join(to.dir, "export-passphrase");
    writeFileSync(passFile, `${PASS}\n`, { mode: 0o600 });
    const loaded = await importCommand([from.file, "--home", to.home, "--passphrase-file", passFile]);
    expect(loaded.stderr).toBe("");
    expect(loaded.code).toBe(0);
    expect(loaded.stdout).toStartWith(`Loaded ${from.file} (written by fleetd `);
    expect(loaded.stdout).toContain("loaded, sealed to this hub's own keys");
    // What isn't carried, as the commands that bring it back.
    expect(loaded.stdout).toContain(`fleetd pair --worker ${M}    # Dev box`);
    expect(loaded.stdout).toContain(`fleetd invite --person ${bo.personId}    # Bo, admin`);
    for (const out of [done, loaded]) {
      expect(out.stdout + out.stderr).not.toContain(PASS);
      expect(out.stdout + out.stderr).not.toContain(SECRET);
    }

    const b = await start(to);
    const me = b.device().caller;
    expect((await b.call(me, "decisions_list", { projectRef: PROJECT })).decisions.map((d: { key: string }) => d.key)).toEqual(["db.engine"]);
    expect(b.v.store.open(b.v.store.get(login.item.itemId as never)!)).toEqual({ username: "ada", password: SECRET });
  });

  test("--no-secrets on either side: the file has none, or they stay in it", async () => {
    const { p: from } = await source();
    const bare = join(from.dir, "export-bare.tar");
    const done = await exportCommand(["--home", from.home, "--out", bare, "--no-secrets"]);
    expect(done).toMatchObject({ code: 0, stderr: "" });
    expect(done.stdout).toContain("left out (--no-secrets)");
    const one = await fresh();
    const loaded = await importCommand([bare, "--home", one.home]);
    expect(loaded).toMatchObject({ code: 0, stderr: "" });
    expect(loaded.stdout).toContain("the secrets, which the export was written without");

    process.env[PASSPHRASE_ENV] = PASS;
    expect((await exportCommand(["--home", from.home, "--out", from.file])).code).toBe(0);
    delete process.env[PASSPHRASE_ENV];
    const two = await fresh();
    const without = await importCommand([from.file, "--home", two.home, "--no-secrets"]);
    expect(without).toMatchObject({ code: 0, stderr: "" });
    expect(without.stdout).toContain("secrets   not loaded");
  });

  test("export refuses before it writes: a file that is there, a short passphrase, no hub", async () => {
    const { p: from } = await source();
    writeFileSync(from.file, "mine");
    process.env[PASSPHRASE_ENV] = PASS;
    expect(await exportCommand(["--home", from.home, "--out", from.file])).toMatchObject({ code: 1, stderr: `fleetd: ${from.file} is already there: name another file with --out.\n` });
    const out = join(from.dir, "export-2.tar");
    process.env[PASSPHRASE_ENV] = "too short";
    expect(await exportCommand(["--home", from.home, "--out", out])).toMatchObject({ code: 1, stderr: "fleetd: The passphrase is 12 characters or more.\n" });
    expect(await exportCommand(["--home", from.home, "--out", out, "--passphrase-file", join(from.dir, "nowhere")])).toMatchObject({ code: 1 });
    expect(await exportCommand(["--home", join(from.dir, "nowhere"), "--out", out])).toMatchObject({ code: 1, stderr: `fleetd: There is no hub at ${join(from.dir, "nowhere")}.\n` });
    expect((await exportCommand(["--home", from.home, "--passphrase", PASS])).code).toBe(2);
    expect(existsSync(out) || existsSync(`${out}.part`)).toBe(false);
  });

  test("import refuses with the exit code a script reads, and changes nothing", async () => {
    const { p: from } = await exported();
    const to = await fresh();
    const before = stateOf(to);
    const run = (...argv: string[]) => importCommand([...argv, "--home", to.home]);

    expect((await run()).code).toBe(2);
    expect((await run(from.file, from.file)).code).toBe(2);
    expect(await run(join(from.dir, "nowhere.tar"))).toMatchObject({ code: 1 });
    const text = join(from.dir, "export-notes.txt");
    writeFileSync(text, "not an export\n");
    expect(await run(text)).toMatchObject({ code: 1, stderr: "fleetd: That file isn't a fleetd export.\n" });

    process.env[PASSPHRASE_ENV] = "not the passphrase";
    const wrong = await run(from.file);
    expect(wrong).toMatchObject({ code: 1, stdout: "" });
    expect(wrong.stderr).toStartWith("fleetd: That isn't the passphrase this export was written with. Nothing was changed");
    process.env[PASSPHRASE_ENV] = PASS;

    const newer = join(from.dir, "export-newer.tar");
    await rewritten(from.file, newer, { header: (h) => void (h.version = 2) });
    const refused = await run(newer);
    expect(refused.code).toBe(3);
    expect(refused.stderr).toEndWith("Update fleetd (fleetd update), then import it again.\n");

    // A hub that has data: the one the export came from.
    const used = await importCommand([from.file, "--home", from.home]);
    expect(used.code).toBe(3);
    expect(used.stderr).toStartWith("fleetd: This hub already has data");

    expect(stateOf(to)).toEqual(before);
  });

  test("import waits for the hub to be stopped: one that has the database open is refused", async () => {
    const { p: from } = await exported();
    const to = await fresh();
    const before = stateOf(to);
    // Another process with the hub's database open, as a running hub has it.
    const holder = Bun.spawn(
      [process.execPath, "-e", 'require("node:fs").openSync(process.argv[1], "r"); process.stdout.write("open\\n"); process.stdin.resume();', join(to.home, "hub.sqlite")],
      { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
    );
    try {
      await holder.stdout.getReader().read();
      process.env[PASSPHRASE_ENV] = PASS;
      const refused = await importCommand([from.file, "--home", to.home]);
      expect(refused.code).toBe(3);
      expect(refused.stderr).toStartWith(`fleetd: A hub is running on ${to.home}. Stop it`);
      expect(refused.stderr).toEndWith("Nothing was changed.\n");
    } finally {
      holder.kill();
      await holder.exited;
    }
    expect(stateOf(to)).toEqual(before);
  });
});
