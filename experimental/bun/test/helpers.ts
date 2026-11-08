import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../src/hub/auth/index.ts";
import type { HubDb } from "../src/hub/store/db.ts";
import type { Grant } from "../src/shared/contracts.ts";

/** A fresh directory under $TMPDIR, removed by the returned function. Never the live hub's home. */
export function tempHome(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-bun-test-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** Inserts an agent key the way the Rust hub stores one (its SHA-256), and returns the key. */
export function insertKey(db: HubDb, grants: Grant[], name = "test"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(52));
  const key = `fld_${[...bytes].map((b) => BASE32[b % 32]).join("")}`;
  db.conn
    .query("INSERT INTO agent_keys (key_id, hash, prefix, name, grants, created_ms, kind) VALUES (?, ?, ?, ?, ?, ?, 'agent')")
    .run(`key_${name}`, sha256(key), key.slice(0, 10), name, JSON.stringify(grants), Date.now());
  return key;
}
