// scripts/vault-migration-check.ts on a made-up hub and node (never a live one): it migrates a copy, keeps every
// table as it was, matches each variable and sink to its node's file, skips fleetd's own GH_TOKEN rows, reports counts
// with no value or name in them, and leaves nothing behind.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS } from "../src/gen/migrations.ts";
import { migrate } from "../src/hub/store/migrations.ts";
import { fingerprintOf } from "../src/node/secrets/files.ts";
import { run, SYSTEM_REQUEST_ID } from "../scripts/vault-migration-check.ts";
import { tempHome } from "./helpers.ts";

const VAULT = MIGRATIONS.findIndex((m) => m.name.endsWith("_vault"));
const SECRET = "example-secret-not-real";
const SINK_VALUE = "example-sink-value-not-real";
const ORDER_VALUE = "example-order-value-not-real";
const SYSTEM_VALUE = "example-system-token-not-real";

function fixture(dir: string) {
  const hub = join(dir, "hub");
  const node = join(dir, "node");
  mkdirSync(hub, { recursive: true });
  mkdirSync(join(node, "project-env"), { recursive: true });
  mkdirSync(join(node, "order-env", "p1"), { recursive: true });
  const conn = new Database(join(hub, "hub.sqlite"), { create: true, strict: true });
  migrate(conn, MIGRATIONS.slice(0, VAULT));
  const at = "2026-11-09T00:00:00Z";
  const env = conn.query(
    "INSERT INTO project_env (machine_id, project_id, name, kind, value, fingerprint, bytes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  env.run("devbox", "p1", "API_URL", "plain", "https://api.example.test", null, 24, at);
  env.run("devbox", "p1", "API_KEY", "secret", null, fingerprintOf(SECRET), SECRET.length, at);
  const order = conn.query(
    "INSERT INTO order_env (machine_id, project_id, workstream_id, name, fingerprint, bytes, request_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  order.run("devbox", "p1", "W7", "DEPLOY_KEY", fingerprintOf(ORDER_VALUE), ORDER_VALUE.length, "Q3", at);
  order.run("devbox", "p1", "W7", "GH_TOKEN", fingerprintOf(SYSTEM_VALUE), SYSTEM_VALUE.length, SYSTEM_REQUEST_ID, at);
  const sinkPath = join(dir, "work", ".env");
  mkdirSync(join(dir, "work"));
  writeFileSync(sinkPath, `OTHER=1\nSTRIPE_TEST_KEY=${SINK_VALUE}\n`);
  const data = {
    secret: { key: "stripe.test_key", sink: `env:devbox:${sinkPath}`, envName: "STRIPE_TEST_KEY", fingerprint: fingerprintOf(SINK_VALUE) },
  };
  conn
    .query("INSERT INTO requests (project_key, kind, state, created_ms, data) VALUES (?, 'secret', 'stored', 1, ?)")
    .run("devbox/p1", JSON.stringify(data));
  conn.close();
  writeFileSync(join(node, "project-env", "p1.json"), JSON.stringify({ vars: { API_KEY: { value: SECRET, secret: true } } }));
  writeFileSync(join(node, "order-env", "p1", "W7.json"), JSON.stringify({ vars: { DEPLOY_KEY: ORDER_VALUE, GH_TOKEN: SYSTEM_VALUE } }));
  writeFileSync(join(node, "secret-sinks.json"), JSON.stringify({ "stripe.test_key": { kind: "env", path: sinkPath, envName: "STRIPE_TEST_KEY" } }));
  return { hub, node };
}

test("the check migrates a copy, matches every variable and sink, skips GH_TOKEN, and cleans up", async () => {
  const home = tempHome();
  const scratch = tempHome();
  const tmp = process.env.TMPDIR;
  process.env.TMPDIR = scratch.dir;
  try {
    const { hub, node } = fixture(home.dir);
    const liveBefore = readFileSync(join(hub, "hub.sqlite"));
    const { counts, problems } = await run({ hubHome: hub, nodeHome: node, machineId: "devbox" });
    expect(problems).toEqual([]);
    expect(Object.fromEntries(counts)).toMatchObject({
      "plain project variables (taken from the hub's rows)": 1,
      "secret project variables": 1,
      "secret project variables matching their node's value": 1,
      "order variables a person gave": 1,
      "order variables matching their node's value": 1,
      "system order variables (GH_TOKEN), skipped": 1,
      "stored env:/file: sinks": 1,
      "stored sinks matching their node's value": 1,
      "sink files copied": 1,
    });
    const printed = JSON.stringify([...counts]);
    for (const secret of [SECRET, SINK_VALUE, ORDER_VALUE, SYSTEM_VALUE, "API_KEY", "DEPLOY_KEY", "stripe"]) {
      expect(printed).not.toContain(secret);
    }
    // The source was only read, and the copies are gone.
    expect(readFileSync(join(hub, "hub.sqlite")).equals(liveBefore)).toBe(true);
    expect(existsSync(join(hub, "hub.sqlite-wal"))).toBe(false);
    expect(readdirSync(scratch.dir)).toEqual([]);
  } finally {
    process.env.TMPDIR = tmp;
    home.done();
    scratch.done();
  }
});

test("a node value that differs from the hub's record is counted, and a missing one is a problem", async () => {
  const home = tempHome();
  try {
    const { hub, node } = fixture(home.dir);
    writeFileSync(join(node, "project-env", "p1.json"), JSON.stringify({ vars: { API_KEY: { value: "changed-not-real", secret: true } } }));
    writeFileSync(join(node, "order-env", "p1", "W7.json"), JSON.stringify({ vars: {} }));
    const { counts, problems } = await run({ hubHome: hub, nodeHome: node, machineId: "devbox" });
    expect(counts.get("secret project variables whose node value is newer (the node's wins)")).toBe(1);
    expect(problems).toEqual(["an order variable is missing from its node's file"]);
  } finally {
    home.done();
  }
});
