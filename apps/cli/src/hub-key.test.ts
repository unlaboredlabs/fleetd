import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as Auth from "@fleetd/hub/auth/Auth.ts";
import * as HubDb from "@fleetd/hub/store/HubDb.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "./cli.ts";

describe("fleetd hub key", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-cli-"));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it("creates, lists and revokes keys that a running hub sees at once", async () => {
    // Stands in for the running hub: its own long-lived connection to the same database.
    const hub = ManagedRuntime.make(Auth.layer.pipe(Layer.provide(HubDb.layer(home))));
    const verify = (key: string) =>
      hub.runPromise(
        Effect.gen(function* () {
          return yield* (yield* Auth.Auth).verify(key);
        }).pipe(Effect.match({ onFailure: (e) => e.message, onSuccess: (info) => info.keyId })),
      );
    try {
      await hub.runPromise(Effect.void);
      const created = run(["hub", "key", "create", "--home", home, "--name", "ci", "--role", "operate", "--machines", "lab-a,lab-b"]);
      expect(created.code).toBe(0);
      const key = created.stdout.trim();
      expect(key).toMatch(/^fld_[a-z2-7]{52}$/u);
      const keyId = /created (key_\w+)/u.exec(created.stderr)?.[1] ?? "";
      expect(await verify(key)).toBe(keyId);

      const listed = run(["hub", "key", "list", "--home", home]);
      expect(listed.stdout).toContain(`${keyId}\t${key.slice(0, 10)}\tci\toperate:lab-a,lab-b\t`);
      expect(listed.stdout).not.toContain(key);

      expect(run(["hub", "key", "revoke", keyId, "--home", home])).toMatchObject({ code: 0, stdout: `revoked ${keyId}\n` });
      expect(await verify(key)).toMatch(/was revoked/u);
      expect(run(["hub", "key", "list", "--home", home]).stdout).toMatch(/\trevoked \S+\n$/u);
    } finally {
      await hub.dispose();
    }
  });

  it("rejects bad grants, unknown keys and homes inside ~/.t3", () => {
    const create = (...args: string[]) => run(["hub", "key", "create", "--home", home, "--name", "x", ...args]);
    expect(create("--role", "root", "--machines", "*")).toMatchObject({ code: 2 });
    expect(create("--role", "read", "--machines", "Lab_A").stderr).toContain("'Lab_A' is not a machine id");
    expect(create("--role", "read")).toMatchObject({ code: 2 });
    expect(run(["hub", "key", "revoke", "key_nope", "--home", home])).toMatchObject({ code: 1 });
    const t3 = run(["hub", "key", "list", "--home", path.join(os.homedir(), ".t3", "hub")]);
    expect(t3.code).toBe(1);
    expect(t3.stderr).toContain("inside ~/.t3");
  });
});
