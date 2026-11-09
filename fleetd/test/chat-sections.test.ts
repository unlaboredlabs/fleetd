import { expect, test } from "bun:test";
import { Hub } from "../src/hub/api/hub.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { register as apiTools } from "../src/hub/api/tools.ts";
import { visible } from "../src/hub/app_ws/visible.ts";
import { kept, putSections, sectionsOf } from "../src/hub/chat_sections/store.ts";
import { register as sectionTools } from "../src/hub/chat_sections/tools.ts";
import { others } from "../src/hub/navi/owner.ts";
import { setArchived, setOnlyMe } from "../src/hub/navi/store.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { store } from "../src/hub/store/hub_store.ts";
import type { AgentKeyInfo, ChatSection, HubEvent, ProjectRef, ProjectSummary } from "../src/shared/contracts.ts";

const ref = (projectId: string, machineId = "devbox"): ProjectRef => ({ machineId, projectId });

function setup() {
  const hub = new Hub({ home: "/nonexistent", listen: { host: "127.0.0.1", port: 0 } }, HubDb.memory(), { now: () => Date.now() });
  const tools = new Registry();
  apiTools(tools);
  sectionTools(tools);
  hub.db.conn.run("INSERT INTO people (person_id, name, role, created_ms) VALUES ('p_adaadaad', 'Ada', 'owner', 1), ('p_bobobobo', 'Bo', 'member', 2)");
  const projects = (machineId: string, ids: string[]) =>
    store(hub).projectsUpsertMany(
      machineId,
      ids.map(
        (projectId) =>
          ({
            machineId,
            projectId,
            title: projectId,
            workspaceRoot: `/srv/${projectId}`,
            lastActivityAt: "2026-11-09T10:00:00.000Z",
            threads: { failed: 0, idle: 0, running: 0, waiting: 0 },
          }) as unknown as ProjectSummary,
      ),
    );
  projects("devbox", ["shop", "site", "docs", "notes"]);
  projects("laptop", ["shop"]);
  const key = (person: string | undefined, grants: AgentKeyInfo["grants"] = [{ role: "admin", machines: "*" }]): AgentKeyInfo => ({
    keyId: `k_${person ?? "agent"}`,
    name: person ?? "agent",
    prefix: "fld_aaaaaa",
    grants,
    createdAt: "2026-11-08T00:00:00.000Z",
    ...(person ? { kind: "human" as const, person: { personId: person, name: person } } : {}),
  });
  const get = async (caller: AgentKeyInfo) => ok(await tools.call(hub, caller, "chat_sections_get", {})).sections as ChatSection[];
  const set = (caller: AgentKeyInfo, sections: unknown) => tools.call(hub, caller, "chat_sections_set", { sections });
  return { hub, tools, key, get, set, ada: key("p_adaadaad"), bo: key("p_bobobobo") };
}

const ok = (r: { output: unknown } | { error: unknown }) => {
  if (!("output" in r)) throw new Error(JSON.stringify(r.error));
  return r.output as Record<string, unknown>;
};

const refusal = (r: { output: unknown } | { error: unknown }) => {
  if (!("error" in r)) throw new Error(`not refused: ${JSON.stringify(r.output)}`);
  const error = r.error as { kind: string; error?: { code: string; message: string }; message?: string };
  return error.kind === "tool" ? `${error.error!.code}: ${error.error!.message}` : `${error.kind}: ${error.message}`;
};

test("the store keeps one list per person, whole and in order, and reads a row it can't parse as none", () => {
  const db = HubDb.memory().conn;
  expect(sectionsOf(db, "p_adaadaad")).toEqual([]);
  const work = { id: "s1", name: "Work", chats: [ref("shop"), ref("site")] };
  const home = { id: "s2", name: "Home", chats: [ref("notes")] };
  putSections(db, "p_adaadaad", [work, home]);
  putSections(db, "p_bobobobo", [home]);
  expect(sectionsOf(db, "p_adaadaad")).toEqual([work, home]);
  putSections(db, "p_adaadaad", [home, work]);
  expect(sectionsOf(db, "p_adaadaad")).toEqual([home, work]);
  expect(sectionsOf(db, "p_bobobobo")).toEqual([home]);
  db.run("UPDATE chat_sections SET sections = 'not json' WHERE person_id = 'p_bobobobo'");
  expect(sectionsOf(db, "p_bobobobo")).toEqual([]);
});

test("kept leaves a chat in the first section that names it, and drops unknown chats and sections left empty", () => {
  const sections = [
    { id: "s1", name: "Work", chats: [ref("shop"), ref("gone"), ref("shop")] },
    { id: "s2", name: "Later", chats: [ref("shop"), ref("gone")] },
    { id: "s3", name: "Home", chats: [ref("site"), ref("shop", "laptop")] },
  ];
  expect(kept(sections, (r) => r.projectId !== "gone")).toEqual([
    { id: "s1", name: "Work", chats: [ref("shop")] },
    { id: "s3", name: "Home", chats: [ref("site"), ref("shop", "laptop")] },
  ]);
});

test("a person's sections are theirs: empty at first, replaced whole by a set, and returned as stored", async () => {
  const { get, set, ada, bo } = setup();
  expect(await get(ada)).toEqual([]);
  const stored = ok(
    await set(ada, [
      { id: "s1", name: "  Work ", chats: [ref("shop"), ref("site")] },
      { id: "s2", name: "Empty", chats: [] },
      { id: "s3", name: "Home", chats: [ref("site"), ref("notes"), ref("shop", "laptop")] },
    ]),
  ).sections;
  // Trimmed, the empty one dropped, and site only in the first that named it.
  expect(stored).toEqual([
    { id: "s1", name: "Work", chats: [ref("shop"), ref("site")] },
    { id: "s3", name: "Home", chats: [ref("notes"), ref("shop", "laptop")] },
  ]);
  expect(await get(ada)).toEqual(stored as ChatSection[]);
  expect(await get(bo)).toEqual([]);

  // The next set replaces the whole list: a section left out is gone, the order is the new one.
  const next = [
    { id: "s3", name: "Home", chats: [ref("notes")] },
    { id: "s1", name: "Shops", chats: [ref("shop"), ref("shop", "laptop")] },
  ];
  expect(ok(await set(ada, next)).sections).toEqual(next);
  expect(await get(ada)).toEqual(next);
  ok(await set(ada, []));
  expect(await get(ada)).toEqual([]);
});

test("a set refuses a list a person can't keep, in plain words, and saves none of it", async () => {
  const { get, set, ada } = setup();
  const before = [{ id: "s1", name: "Work", chats: [ref("shop")] }];
  ok(await set(ada, before));
  const one = (name: string, id = "s9") => ({ id, name, chats: [ref("site")] });

  expect(refusal(await set(ada, [...before, one("   ")]))).toBe("invalid: A section needs a name.");
  expect(refusal(await set(ada, [...before, one("x".repeat(41))]))).toBe(
    `invalid: A section's name is at most 40 characters: “${"x".repeat(41)}” has 41.`,
  );
  expect(refusal(await set(ada, [...before, one(" Work ")]))).toBe("invalid: Two sections are named “Work”.");
  expect(refusal(await set(ada, [...before, one("Home", "s1")]))).toBe("invalid: Two sections have the id s1.");
  const many = Array.from({ length: 51 }, (_, i) => one(`Section ${i}`, `m${i}`));
  expect(refusal(await set(ada, many))).toBe("invalid: At most 50 sections: this list has 51.");
  // An id is the app's to make: a missing or over-long one doesn't decode.
  expect(refusal(await set(ada, [one("Home", "")]))).toStartWith("invalid: ");
  expect(refusal(await set(ada, [one("Home", "i".repeat(65))]))).toStartWith("invalid: ");
  expect(refusal(await set(ada, [{ name: "Home", chats: [] }]))).toStartWith("invalid: ");
  expect(await get(ada)).toEqual(before);

  // The limits themselves pass: 40 characters, counted as a person reads them, and 50 sections.
  const wide = "é".repeat(39) + "🙂";
  expect(ok(await set(ada, [one(wide)])).sections).toEqual([one(wide)]);
  expect((ok(await set(ada, many.slice(0, 50))).sections as ChatSection[]).length).toBe(1);
});

test("only a person keeps sections: an agent's key reads none and is refused a set", async () => {
  const { hub, tools, key, get, set, ada } = setup();
  const sections = [{ id: "s1", name: "Work", chats: [ref("shop")] }];
  ok(await set(ada, sections));
  const agent = key(undefined);
  expect(await get(agent)).toEqual([]);
  expect(refusal(await set(agent, sections))).toBe("forbidden: Only a person keeps chat sections, from one of their own devices.");
  // A removed person's device is nobody's.
  hub.db.conn.run("UPDATE people SET removed_ms = 5 WHERE person_id = 'p_adaadaad'");
  expect(await get(ada)).toEqual([]);
  expect(refusal(await tools.call(hub, ada, "chat_sections_set", { sections }))).toStartWith("forbidden: Only a person keeps chat sections");
});

test("a set announces chat.sections to that person's devices only", async () => {
  const { hub, tools, key, set, ada, bo } = setup();
  ok(await set(ada, [{ id: "s1", name: "Work", chats: [ref("shop")] }]));
  const adaSees = ok(await tools.call(hub, ada, "events_wait", { cursor: 0, timeoutSec: 0 }));
  expect(adaSees.events).toMatchObject([{ type: "chat.sections", data: { personId: "p_adaadaad" } }]);
  const event = (adaSees.events as HubEvent[])[0]!;

  // Neither another person's device nor an agent's key gets it, by events_wait, events_list or the app's stream.
  for (const other of [bo, key(undefined)]) {
    const sees = ok(await tools.call(hub, other, "events_wait", { cursor: 0, timeoutSec: 0 }));
    expect(sees.events).toEqual([]);
    expect(sees.cursor).toBe(1);
    expect(visible(hub.db, other, others(hub.db, other), event)).toBe(false);
  }
  expect(visible(hub.db, ada, others(hub.db, ada), event)).toBe(true);
  // A second device of Ada's is hers too.
  expect(visible(hub.db, { ...ada, keyId: "k_phone" }, others(hub.db, ada), event)).toBe(true);

  // A refused set announces nothing.
  refusal(await set(ada, [{ id: "s1", name: "", chats: [ref("shop")] }]));
  expect(ok(await tools.call(hub, ada, "events_wait", { cursor: 1, timeoutSec: 0 })).events).toEqual([]);
});

test("a deleted project leaves its section at the next read, and an archived one keeps its place", async () => {
  const { hub, get, set, ada } = setup();
  ok(
    await set(ada, [
      { id: "s1", name: "Work", chats: [ref("shop"), ref("site")] },
      { id: "s2", name: "Docs", chats: [ref("docs")] },
    ]),
  );
  setArchived(hub.db.conn, ref("site"), 5);
  store(hub).projectRemove(ref("shop"));
  store(hub).projectRemove(ref("docs"));
  // No set in between: the read leaves them out, and the section with nothing left isn't listed.
  expect(await get(ada)).toEqual([{ id: "s1", name: "Work", chats: [ref("site")] }]);

  // A set that still names them (an app that hasn't heard yet) is not refused: they are left out as it is stored.
  const stale = [
    { id: "s2", name: "Docs", chats: [ref("docs"), ref("never-was")] },
    { id: "s1", name: "Work", chats: [ref("shop"), ref("site"), ref("notes")] },
  ];
  expect(ok(await set(ada, stale)).sections).toEqual([{ id: "s1", name: "Work", chats: [ref("site"), ref("notes")] }]);
  expect(sectionsOf(hub.db.conn, "p_adaadaad")).toEqual([{ id: "s1", name: "Work", chats: [ref("site"), ref("notes")] }]);
});

test("a chat that is not the person's to see is left out, not refused", async () => {
  const { hub, key, get, set, ada, bo } = setup();
  const sections = [
    { id: "s1", name: "Work", chats: [ref("shop"), ref("notes")] },
    { id: "s2", name: "Laptop", chats: [ref("shop", "laptop")] },
  ];
  ok(await set(bo, sections));
  // Ada makes notes hers alone: Bo's list no longer shows it, and his next save goes through without it.
  setOnlyMe(hub.db.conn, ref("notes"), true, "p_adaadaad");
  expect(await get(bo)).toEqual([{ id: "s1", name: "Work", chats: [ref("shop")] }, sections[1]!]);
  expect(ok(await set(bo, sections)).sections).toEqual([{ id: "s1", name: "Work", chats: [ref("shop")] }, sections[1]!]);
  expect(ok(await set(ada, sections)).sections).toEqual(sections);

  // A device that reads only devbox keeps nothing of another machine's chats.
  const narrow = key("p_bobobobo", [{ role: "operate", machines: ["devbox"] }]);
  expect(ok(await set(narrow, sections)).sections).toEqual([{ id: "s1", name: "Work", chats: [ref("shop")] }]);
});
