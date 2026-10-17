import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MachineId } from "@fleetd/contracts";
import * as Auth from "@fleetd/hub/auth/Auth.ts";
import * as HubDb from "@fleetd/hub/store/HubDb.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, runLongRunning } from "./cli.ts";

describe("fleetd hub token create", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-cli-"));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it("prints a one-time token the hub accepts once for that machine", async () => {
    const created = run(["hub", "token", "create", "--machine", "lab-a", "--home", home]);
    expect(created.code).toBe(0);
    const token = created.stdout.trim();
    expect(token).toMatch(/^fle_[a-z2-7]+$/u);
    expect(created.stderr).toContain("fleetd node join --hub <hub url> --token <token> --machine lab-a");
    expect(created.stderr).not.toContain(token);

    const consume = (machine: string) =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* Auth.Auth).consumeEnrollToken(token, MachineId.make(machine), "cHVi");
        }).pipe(
          Effect.match({ onFailure: (error) => error.message, onSuccess: () => "ok" }),
          Effect.provide(Auth.layer.pipe(Layer.provide(HubDb.layer(home)))),
        ),
      );
    expect(await consume("lab-b")).toContain("is for machine lab-a");
    expect(await consume("lab-a")).toBe("ok");
    expect(await consume("lab-a")).toBe("enrollment token was already used");
  });

  it("rejects a missing or malformed machine id", () => {
    expect(run(["hub", "token", "create", "--home", home]).stderr).toContain("--machine is required");
    expect(run(["hub", "token", "create", "--machine", "Lab_A", "--home", home])).toMatchObject({ code: 2 });
  });
});

describe("fleetd node", () => {
  it("names the missing join flag, and refuses to run before joining", async () => {
    const stderr: Array<string> = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => stderr.push(String(chunk)) > 0;
    try {
      expect(await runLongRunning(["node", "join", "--hub", "http://127.0.0.1:4790", "--machine", "lab-a"])).toBe(2);
      expect(stderr.join("")).toContain("--token is required");
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-node-"));
      try {
        expect(await runLongRunning(["node", "run", "--home", empty])).toBe(1);
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
      expect(stderr.join("")).toContain("has not joined a hub");
    } finally {
      process.stderr.write = write;
    }
    expect(runLongRunning(["hub", "key", "list"])).toBeUndefined();
  });
});
