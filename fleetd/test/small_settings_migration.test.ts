// W598's migration (src/hub/store/migrations/<ts>_small_settings_gone.sql) on a hub that used the cut settings: a
// project's setup is copied into each other repo that ran it, its own directory's repo setup becomes the project's,
// the memory refresh switch goes, and hub MCP servers' roles become one "Agents get it too".
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "../src/gen/migrations.ts";
import { migrate } from "../src/hub/store/migrations.ts";

const AT = MIGRATIONS.findIndex((m) => m.name.endsWith("_small_settings_gone"));

const setup = (commands: string[]) => JSON.stringify({ commands, timeoutSec: 900, runAnyway: true, inputs: [] });
const server = (name: string, roles: Record<string, boolean>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ scope: { kind: "global" }, name, enabled: true, roles, transport: { type: "http", url: "https://x.example" }, ...extra });

test("the cut settings' values carry over", () => {
  expect(AT).toBeGreaterThan(0);
  const conn = new Database(":memory:", { strict: true });
  migrate(conn, MIGRATIONS.slice(0, AT));
  conn.run(
    `INSERT INTO project_settings (machine_id, project_id, setup, memory_refresh) VALUES
       ('devbox', 'shop', ?1, 0), ('devbox', 'blog', NULL, 1), ('devbox', 'docs', ?2, 1)`,
    [setup(["pnpm install"]), setup(["make"])],
  );
  // shop: its own directory has its own setup; api runs the project's; web has its own.
  conn.run(
    `INSERT INTO repos (machine_id, project_id, name, checkout_machine_id, checkout_project_id, setup) VALUES
       ('devbox', 'shop', 'shop', 'devbox', 'shop', ?1),
       ('devbox', 'shop', 'api', 'devbox', 'api', NULL),
       ('devbox', 'shop', 'web', 'devbox', 'web', ?2),
       ('devbox', 'blog', 'blog', 'devbox', 'blog', ?3),
       ('devbox', 'docs', 'site', 'devbox', 'site', NULL)`,
    [setup(["bun install"]), setup(["npm ci"]), setup(["hugo"])],
  );
  conn.run(
    "INSERT INTO mcp_servers (machine_id, project_id, name, data) VALUES ('', '', 'lead', ?1), ('', '', 'writers', ?2), ('', '', 'nobody', ?3), ('devbox', 'shop', 'mail', ?4)",
    [
      server("lead", { lead: true, writers: false, reviewers: false }),
      server("writers", { lead: false, writers: true, reviewers: false }),
      server("nobody", { lead: false, writers: false, reviewers: false }),
      server("mail", { lead: true, writers: true, reviewers: false }, { integration: {} }),
    ],
  );
  migrate(conn, MIGRATIONS);

  const commands = (json: string | null) => (json === null ? null : (JSON.parse(json) as { commands: string[] }).commands);
  const project = (p: string) => commands(conn.query<{ setup: string | null }, [string]>("SELECT setup FROM project_settings WHERE project_id = ?").get(p)?.setup ?? null);
  const repo = (name: string) => commands(conn.query<{ setup: string | null }, [string]>("SELECT setup FROM repos WHERE name = ?").get(name)?.setup ?? null);
  expect([project("shop"), repo("shop"), repo("api"), repo("web")]).toEqual([["bun install"], null, ["pnpm install"], ["npm ci"]]);
  expect([project("blog"), repo("blog")]).toEqual([["hugo"], null]);
  expect([project("docs"), repo("site")]).toEqual([["make"], ["make"]]);
  const columns = conn.query<{ name: string }, []>("SELECT name FROM pragma_table_info('project_settings')").all().map((c) => c.name);
  expect(columns).not.toContain("memory_refresh");

  const of = (name: string) => JSON.parse(conn.query<{ data: string }, [string]>("SELECT data FROM mcp_servers WHERE name = ?").get(name)!.data);
  expect(of("lead")).toMatchObject({ enabled: true, roles: { lead: true, writers: false, reviewers: false } });
  expect(of("writers")).toMatchObject({ enabled: true, roles: { lead: true, writers: true, reviewers: true } });
  expect(of("nobody")).toMatchObject({ enabled: false, roles: { lead: true, writers: false, reviewers: false } });
  expect(of("mail").roles).toEqual({ lead: true, writers: true, reviewers: false });
});
