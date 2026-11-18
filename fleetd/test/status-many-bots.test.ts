// fleetd_status on a hub of 40 bots with long chats (W701): every connect asks for it twice (the snapshot, then the
// app's own call), and it holds the hub's only thread while it runs. Each bot's chat state is read once per change
// to its chat, and its open items through their own index, so neither grows with the chats' length.
import { afterAll, expect, test } from "bun:test";
import { build } from "../src/hub/serve/index.ts";
import { chat } from "../src/hub/chat/index.ts";
import { store } from "../src/hub/store/hub_store.ts";
import type { ProjectChatState, ProjectRef, ProjectSummary } from "../src/shared/contracts.ts";
import { caller } from "./hub-helpers.ts";
import { hubHome } from "./helpers.ts";

const BOTS = 40;
const MESSAGES = 3000;
const home = hubHome();
const { hub, tools } = build(home.dir, { host: "127.0.0.1", port: 0 });
afterAll(() => {
  hub.shutdown.abort();
  hub.db.close();
  home.done();
});

const ref = (n: number): ProjectRef => ({ machineId: "devbox", projectId: `bot-${n}` });
const at = Date.parse("2026-11-18T10:00:00Z");
store(hub).projectsUpsertMany(
  "devbox",
  Array.from({ length: BOTS }, (_, i) => ({
    ...ref(i + 1),
    title: `Bot ${i + 1}`,
    workspaceRoot: `/srv/bot-${i + 1}`,
    lastActivityAt: new Date(at - i * 1000).toISOString(),
    threads: { failed: 0, idle: 0, running: 0, waiting: 0 },
  })) as unknown as ProjectSummary[],
);
// Long chats as a busy bot's read: the lead's long replies, people's short ones, an item now and then, all settled.
const text = "Here is what changed and why, with the log tail. ".repeat(16);
const insert = hub.db.conn.prepare(
  "INSERT INTO chat_messages (machine_id, project_id, seq, created_ms, data) VALUES ('devbox', ?1, ?2, ?3, ?4)",
);
hub.db.conn.transaction(() => {
  for (let b = 1; b <= BOTS; b++) {
    const r = ref(b);
    for (let seq = 1; seq <= MESSAGES; seq++) {
      const author = seq % 3 === 0 ? "human" : "lead";
      const item = seq % 50 === 0 ? { kind: "secret_request", state: "done" } : undefined;
      const data = { messageId: `m${b}-${seq}`, projectRef: r, seq, author, text: author === "lead" ? `${text}${seq}` : "ok", attachments: [], createdAt: new Date(at + seq).toISOString(), state: "final", ...(item ? { item } : {}) };
      insert.run(r.projectId, seq, at + seq, JSON.stringify(data));
    }
  }
})();

const admin = caller("admin", true);
async function status(): Promise<{ ms: number; chats: ProjectChatState[] }> {
  const t0 = performance.now();
  const out = (await tools.call(hub, admin, "fleetd_status", {})) as { output: { chats: ProjectChatState[] } };
  return { ms: performance.now() - t0, chats: out.output.chats };
}

test("fleetd_status at 40 bots of 3,000 messages each answers in under 50 ms, the connect's second ask included", async () => {
  const first = await status();
  expect(first.chats.length).toBe(BOTS);
  expect(first.chats.every((c) => c.lastSeq === MESSAGES && !c.needsYou)).toBe(true);
  const again: number[] = [];
  for (let i = 0; i < 5; i++) again.push((await status()).ms);
  again.sort((a, b) => a - b);
  expect(again[2]).toBeLessThan(50);
});

test("a bot's chat state is read again as soon as its chat changes, by any writer", async () => {
  const r = ref(7);
  const state = async () => (await status()).chats.find((c) => c.projectRef.projectId === r.projectId);
  expect(await state()).toMatchObject({ needsYou: false, lastSeq: MESSAGES });
  const question = chat(hub).add(r, { author: "lead", text: "Ship it today?", source: "lead:t7:q" }).message;
  expect(await state()).toMatchObject({ needsYou: true, lastSeq: MESSAGES + 1 });
  // A write outside the chat's own (an erase, an import) is seen too.
  hub.db.conn.run("DELETE FROM chat_messages WHERE machine_id = 'devbox' AND project_id = ?1 AND seq = ?2", [r.projectId, question.seq]);
  expect(await state()).toMatchObject({ needsYou: false, lastSeq: MESSAGES });
  const item = chat(hub).add(r, { author: "system", text: "", item: { kind: "secret_request", state: "open" } as never }).message;
  expect(await state()).toMatchObject({ needsYou: true, openItems: [{ messageId: item.messageId, kind: "secret_request" }] });
  // The other bots' states were kept: only bot 7's chat changed.
  expect((await status()).chats.filter((c) => c.needsYou).map((c) => c.projectRef.projectId)).toEqual([r.projectId]);
});
