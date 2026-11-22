// W789's migration (src/hub/store/migrations/<ts>_hub_links_gone.sql): hub links are gone, so their tables go with the
// keys they kept, and so do the asks that came in or went out through a link, with their orders; every other ask stays.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "../src/gen/migrations.ts";
import { migrate } from "../src/hub/store/migrations.ts";

const AT = MIGRATIONS.findIndex((m) => m.name.endsWith("_hub_links_gone"));

test("the link tables and their keys go, and so do the asks through a link", () => {
  expect(AT).toBeGreaterThan(0);
  const conn = new Database(":memory:", { strict: true });
  migrate(conn, MIGRATIONS.slice(0, AT));
  conn.run(
    `INSERT INTO hub_links_issued (link_id, hash, prefix, label, key_id, device, created_ms) VALUES ('hl_1', 'h', 'flk_ab', 'Work', 'k1', 'phone', 1)`,
  );
  conn.run(
    `INSERT INTO hub_links (link_id, machine_id, project_id, label, url, sealed, cursor, state, created_ms)
       VALUES ('hl_2', 'devbox', 'shop', 'Home', 'https://home.example', x'00', 0, 'ok', 1)`,
  );
  conn.run(
    `INSERT INTO project_asks (n, from_machine_id, from_project_id, to_machine_id, to_project_id, text, at_ms, via_link, to_hub, remote) VALUES
       (1, 'devbox', 'shop', 'devbox', 'billing', 'Invoices.', 1, NULL, NULL, NULL),
       (2, '', '', 'devbox', 'billing', 'From the other hub.', 2, 'hl_1', NULL, NULL),
       (3, 'devbox', 'shop', 'far', 'books', 'To the other hub.', 3, NULL, 'hl_2', 'N9')`,
  );
  conn.run("INSERT INTO project_ask_orders (workstream_id, n) VALUES ('W1', 1), ('W2', 2), ('W3', 3)");
  migrate(conn, MIGRATIONS);

  const tables = conn.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'hub_link%'").all();
  expect(tables).toEqual([]);
  expect(conn.query("SELECT * FROM project_asks").all()).toEqual([
    { n: 1, from_machine_id: "devbox", from_project_id: "shop", to_machine_id: "devbox", to_project_id: "billing", text: "Invoices.", at_ms: 1, reply: null },
  ]);
  expect(conn.query("SELECT workstream_id, n FROM project_ask_orders").all()).toEqual([{ workstream_id: "W1", n: 1 }]);
});
