import { expect, test } from "bun:test";
import { Auth } from "../src/hub/auth/index.ts";
import { base32, Unauthorized } from "../src/hub/auth/nodes.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { insertKey } from "./helpers.ts";

const at = (ms: number) => ({ now: () => ms });

test("a person's role caps their device's grants, and an empty name reads Owner", () => {
  const db = HubDb.memory();
  const auth = new Auth(db, at(1_792_000_000_000));
  const key = insertKey(db, [{ role: "admin", machines: "*" }], "phone");
  db.conn.run("INSERT INTO people (person_id, name, role, created_ms) VALUES ('p_a', ' \u0007 ', 'member', 1)");
  db.conn.run("UPDATE agent_keys SET person_id = 'p_a', kind = 'human'");
  const member = auth.verify(key);
  expect(member.grants).toEqual([{ role: "operate", machines: "*" }]);
  expect(member.person).toEqual({ personId: "p_a", name: "Owner" });
  db.conn.run("UPDATE people SET role = 'admin', name = 'Ada'");
  expect(auth.verify(key).grants).toEqual([{ role: "admin", machines: "*" }]);
  db.conn.run("UPDATE people SET role = 'nonsense'");
  expect(auth.verify(key).grants).toEqual([{ role: "operate", machines: "*" }]);
});

test("enroll codes: one open per machine, burned once, and each refusal says how to get on", () => {
  let now = 1_792_000_000_000;
  const db = HubDb.memory();
  const auth = new Auth(db, { now: () => now });
  const nodes = auth.nodes;
  const first = nodes.createEnrollToken("devbox", "test");
  expect(first.token).toMatch(/^fle_[a-z2-7]{52}$/);
  const second = nodes.createEnrollToken("devbox", "test");
  expect(nodes.openEnrollTokens().map((c) => c.machineId)).toEqual(["devbox"]);
  const refusal = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      return (error as Unauthorized).reason();
    }
    return "accepted";
  };
  expect(refusal(() => nodes.enrollNode(first.token, "devbox", "k1"))).toBe(
    "unknown, replaced or revoked enrollment token. Fix: on the hub, run fleetd pair --worker devbox for a new code",
  );
  expect(refusal(() => nodes.enrollNode(second.token, "laptop", "k1"))).toBe(
    "enrollment token is for machine devbox, not laptop. Fix: join as devbox (--machine-id devbox)",
  );
  expect(refusal(() => nodes.enrollNode(second.token, "devbox", "k1", "fp"))).toBe("accepted");
  expect(nodes.nodePubKey("devbox")).toBe("k1");
  expect(nodes.nodeFingerprint("devbox")).toBe("fp");
  // The same key under a second id, or a second computer under this id, is refused.
  const other = nodes.createEnrollToken("laptop", "test");
  expect(refusal(() => nodes.enrollNode(other.token, "laptop", "k1"))).toBe(
    "enrolled as devbox. Fix: fleetd pair --worker devbox and run its line, or fleetd machine remove devbox first",
  );
  const again = nodes.createEnrollToken("devbox", "test");
  expect(refusal(() => nodes.enrollNode(again.token, "devbox", "k2", "fp2"))).toBe(
    "devbox is another computer's machine id. Fix: use an id of its own, or fleetd machine remove devbox first",
  );
  now += 16 * 60_000;
  expect(refusal(() => nodes.enrollNode(again.token, "devbox", "k1"))).toBe(
    "enrollment token expired. Fix: on the hub, run fleetd pair --worker devbox for a new code",
  );
  expect(nodes.revokeNode("devbox")).toBe(true);
  expect(nodes.nodePubKey("devbox")).toBeUndefined();
});

test("a nameless code enrolls the computer under the name it asks for, made unique, and only once", () => {
  const db = HubDb.memory();
  const nodes = new Auth(db, at(1_792_000_000_000)).nodes;
  const code = () => nodes.createEnrollToken(undefined, "test").token;
  const refusal = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      return (error as Unauthorized).reason();
    }
    return "accepted";
  };
  // A nameless code replaces no other: one line per computer, several open at once.
  const [first, second] = [code(), code()];
  expect(nodes.openEnrollTokens().map((c) => c.machineId)).toEqual(["", ""]);
  expect(nodes.enrollNode(first, "laptop", "k1", "fp1")).toBe("laptop");
  expect(nodes.nodePubKey("laptop")).toBe("k1");
  expect(refusal(() => nodes.enrollNode(first, "laptop", "k9", "fp9"))).toBe(
    "enrollment token was already used. Fix: ask the hub for a new join line",
  );
  // Another computer by that name gets the next free one.
  expect(nodes.enrollNode(second, "laptop", "k2", "fp2")).toBe("laptop-2");
  expect(nodes.nodePubKey("laptop-2")).toBe("k2");
  // The same computer joins again under its own id: by its key, whatever it asks for, or by its fingerprint.
  expect(nodes.enrollNode(code(), "renamed", "k1", "fp1")).toBe("laptop");
  expect(nodes.enrollNode(code(), "laptop", "k3", "fp1")).toBe("laptop");
  expect(nodes.nodePubKey("laptop")).toBe("k3");
  // A name a known machine or an open code for one holds is taken too; a long one is cut to fit its suffix.
  db.conn.run("INSERT INTO machines (machine_id, data) VALUES ('mini', '{}')");
  expect(nodes.enrollNode(code(), "mini", "k4", "fp4")).toBe("mini-2");
  nodes.createEnrollToken("studio", "test");
  expect(nodes.enrollNode(code(), "studio", "k5", "fp5")).toBe("studio-2");
  const long = `${"a".repeat(29)}-bc`;
  expect(nodes.enrollNode(code(), long, "k6", "fp6")).toBe(long);
  expect(nodes.enrollNode(code(), long, "k7", "fp7")).toBe(`${"a".repeat(29)}-2`);
  // A code minted for a name still admits only that name.
  const named = nodes.createEnrollToken("builder-1", "test").token;
  expect(refusal(() => nodes.enrollNode(named, "laptop-3", "k8", "fp8"))).toBe(
    "enrollment token is for machine builder-1, not laptop-3. Fix: join as builder-1 (--machine-id builder-1)",
  );
});

test("base32 is RFC 4648's, lowercase and unpadded", () => {
  expect(base32(new TextEncoder().encode("foobar"))).toBe("mzxw6ytboi");
  expect(base32(new Uint8Array(32)).length).toBe(52);
});
