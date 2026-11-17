// W687's migration (src/hub/store/migrations/<ts>_chat_folds_gone.sql): the tagged chat no longer folds a closed
// order's messages, so the fold the hub kept on a message goes from it and from the chat event that carried it, and
// the rest of each stays.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "../src/gen/migrations.ts";
import { migrate } from "../src/hub/store/migrations.ts";

const AT = MIGRATIONS.findIndex((m) => m.name.endsWith("_chat_folds_gone"));

test("a stored fold goes, from the message and its chat event", () => {
  expect(AT).toBeGreaterThan(0);
  const conn = new Database(":memory:", { strict: true });
  migrate(conn, MIGRATIONS.slice(0, AT));
  const about = { workstreamId: "W3", title: "Search speed" };
  const folded = { messageId: "m2", author: "lead", text: "Search speed is live.", about, fold: { ...about, state: "done", count: 2 } };
  const plain = { messageId: "m1", author: "lead", text: "Looking.", about };
  conn.run(
    `INSERT INTO chat_messages (n, machine_id, project_id, seq, created_ms, held, data) VALUES
       (1, 'devbox', 'shop', 1, 1, 0, ?1), (2, 'devbox', 'shop', 2, 2, 0, ?2)`,
    [JSON.stringify(plain), JSON.stringify(folded)],
  );
  conn.run(
    `INSERT INTO events (created_ms, type, machine_id, data) VALUES (2, 'chat.message', 'devbox', ?1), (3, 'workstream.done', 'devbox', ?2)`,
    [JSON.stringify({ message: folded }), JSON.stringify({ workstreamId: "W3", fold: "kept" })],
  );
  migrate(conn, MIGRATIONS);

  const messages = conn.query<{ data: string }, []>("SELECT data FROM chat_messages ORDER BY n").all().map((r) => JSON.parse(r.data) as unknown);
  const { fold: _f, ...unfolded } = folded;
  expect(messages).toEqual([plain, unfolded]);
  const events = conn.query<{ data: string }, []>("SELECT data FROM events ORDER BY created_ms").all().map((r) => JSON.parse(r.data) as unknown);
  // Only a chat event's message loses it.
  expect(events).toEqual([{ message: unfolded }, { workstreamId: "W3", fold: "kept" }]);
});
