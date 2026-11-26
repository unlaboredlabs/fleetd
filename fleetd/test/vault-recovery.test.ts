// The vault's key file lost on a workspace whose items are sealed under it: the workspace refuses to make a new key
// and says how to restore it, and `fleetd vault restore-key` puts it back, even over a key an older workspace made in
// its place, sealing what was saved under that one again so nothing is lost.
import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Hub } from "../src/hub/api/hub.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { Vault } from "../src/hub/vault/index.ts";
import { keyDir, recoveryCode, VaultKeys } from "../src/hub/vault/keys.ts";
import { tempHome } from "./helpers.ts";

const login = (label: string) =>
  ({ kind: "login", scope: "hub", label, meta: { sites: ["shop.example"], fields: ["username", "password"], source: { kind: "typed" } } }) as never;

test("a lost key file isn't replaced while items are sealed under it, and restore-key brings it back over a stand-in", async () => {
  const tmp = tempHome();
  try {
    const home = join(tmp.dir, "hub");
    const hub = new Hub({ home, listen: { host: "127.0.0.1", port: 4790 } }, HubDb.open(home), { now: () => 1_792_000_000_000 });
    const first = new Vault(hub);
    await first.load();
    expect(first.problem).toBeUndefined();
    const a = first.store.insert(login("Shop"), { username: "ada", password: "planted-a-1" }, "p_owner", 1);
    const code = recoveryCode(first.keys.active().key);
    const path = join(keyDir(home), "root.key");

    rmSync(path);
    const after = new Vault(hub);
    await after.load();
    expect(after.problem?.reason).toBe("vault_key_missing");
    expect(after.problem?.message).toContain("is gone");
    expect(existsSync(path)).toBe(false);

    // What an older workspace did: a new key under the same id, and an item saved under it.
    await new VaultKeys(keyDir(home)).load(true);
    const stand = new Vault(hub);
    await stand.load();
    expect(stand.problem?.reason).toBe("vault_key_bad");
    const b = stand.store.insert(login("Mail"), { username: "ada", password: "planted-b-1" }, "p_owner", 2);

    const run = Bun.spawnSync(["bun", join(import.meta.dir, "../src/main.ts"), "vault", "restore-key", "--home", home], {
      stdin: new TextEncoder().encode(`${code}\n`),
      env: { ...process.env, FLEETD_HOME: home },
    });
    expect(run.stderr.toString()).toBe("");
    expect(run.stdout.toString()).toStartWith(`The vault key k1 is back in ${path}. 1 item saved while it was missing is sealed under it again.`);

    const back = new Vault(hub);
    await back.load();
    expect(back.problem).toBeUndefined();
    expect(back.store.open(back.store.get(a.itemId)!)).toEqual({ username: "ada", password: "planted-a-1" });
    expect(back.store.open(back.store.get(b.itemId)!)).toEqual({ username: "ada", password: "planted-b-1" });
    // And again: it's in place now.
    const again = Bun.spawnSync(["bun", join(import.meta.dir, "../src/main.ts"), "vault", "restore-key", "--home", home], {
      stdin: new TextEncoder().encode(`${code}\n`),
    });
    expect(again.stdout.toString()).toBe("The vault key k1 is already in place.\n");
    hub.db.conn.close();
  } finally {
    tmp.done();
  }
});

test("an empty vault whose key file went starts over with a fresh key", async () => {
  const tmp = tempHome();
  try {
    const home = join(tmp.dir, "hub");
    const hub = new Hub({ home, listen: { host: "127.0.0.1", port: 4790 } }, HubDb.open(home), { now: () => 1_792_000_000_000 });
    await new Vault(hub).load();
    rmSync(join(keyDir(home), "root.key"));
    const fresh = new Vault(hub);
    await fresh.load();
    expect(fresh.problem).toBeUndefined();
    expect(fresh.keys.locked).toBe(false);
    hub.db.conn.close();
  } finally {
    tmp.done();
  }
});
