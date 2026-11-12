// `--areas`'s seeds (tests/compare/areas.ts) on the open hub itself, not a stand-in: every module's tools served over
// /mcp, with a vault, called through the suite's own seed with a person's admin key. A seed the hub refuses (as the
// vault's personal env item was, once the hub kept one team vault) fails here, not only in a run of the suite by hand.
// And the vault seed's mark sits where only a reveal shows it, so the two-team cases' canary keeps its meaning. Then the
// whole `--areas` contract on it: every tool the hub lists called as a run calls it, and none fails, so a tool the run
// calls wrongly, or a hub answer its schema doesn't hold, fails here too.
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import mcpToolsText from "../../../app/desktop/src/shared/contracts/schema/McpTools.json" with { type: "text" };
import { areasContract, seed } from "../../../tests/compare/areas.ts";
import { openSession } from "../../../tests/compare/mcp.ts";
import type { Team } from "../../../tests/compare/target.ts";
import { decodeOutput } from "../../src/hub/api/decode.ts";
import { doctor } from "../../src/hub/doctor/index.ts";
import { githubApps } from "../../src/hub/github_app/index.ts";
import { serve, stop } from "../../src/hub/http/index.ts";
import { addingGh } from "../../src/hub/projects/discover.ts";
import { people } from "../../src/hub/people/store.ts";
import { build } from "../../src/hub/serve/index.ts";
import { vault } from "../../src/hub/vault/index.ts";
import { openSealed, publicKeyOf } from "../../src/shared/sealed_box_core.ts";
import { hubHome } from "../helpers.ts";

const contract = JSON.parse(mcpToolsText);
// GitHub, as it answers a code it never gave: every call is Not Found.
const github = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ message: "Not Found" }, { status: 404 }) });
const done: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of done) await close();
  await github.stop(true);
});

/** An open hub of its own for a test, as a run's team: served on a free port, its home under $TMPDIR. */
function openHub(): Team {
  const home = hubHome();
  const { hub, tools } = build(home.dir, { host: "127.0.0.1", port: 0 });
  // The vault's key in the test's home, not beside it (a hub's own goes in the folder above its home).
  vault(hub, { dir: join(home.dir, "vault"), scryptN: 1024 });
  // Stand-ins for the hub's own gh: the doctor's checks (test/preload.ts) and project_discover's repo list run none.
  const d = doctor(hub);
  d.health = async () => ({ ok: true });
  d.runCmd = async () => ({ ran: false, error: "ENOENT" });
  Object.assign(addingGh(hub), { repoList: async () => ({ owners: [], repos: [], problem: "gh is not here" }) });
  githubApps(hub).setEndpoints({ api: github.url.origin, web: github.url.origin });
  const owner = people(hub).ensureOwner();
  const server = serve(hub, tools, 0);
  done.push(async () => {
    await stop(server);
    hub.shutdown.abort();
    hub.db.close();
    home.done();
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    key: async ({ name }) => hub.auth.keys.createKeyFor(name, [{ role: "admin", machines: "*" }], "human", owner.personId).key,
    enrol: async () => {
      throw new Error("no machine joins an --areas run");
    },
  };
}

test("every seed of --areas the hub lists is one the open hub takes, and the vault's mark shows only in a reveal", async () => {
  const team = openHub();
  const as = await openSession(team.url, await team.key({ name: "areas", role: "admin", human: true }));
  const listed = await as.tools();
  const made = await seed(team, as, listed, contract, "canary-hub", 2);
  const seeded = new Set(made.map((m) => m.tool));
  // Every seed whose tools the hub lists was made: none skipped for want of a tool, none refused (seed throws).
  for (const tool of ["decisions_record", "invite_create", "attachment_put", "person_avatar_set", "prompt_set", "work_claim", "cap_set", "profile_create", "vault_save", "vault_unlock", "push_device_register"]) {
    expect(seeded).toContain(tool);
  }

  const items = made.filter((m) => m.tool === "vault_save").map((m) => (m.answer.body as { item: { itemId: string } }).item.itemId);
  expect(items).toHaveLength(2);
  const listing = await as.call("vault_list", {});
  expect(listing.isError).toBe(false);
  expect(JSON.stringify(listing.body)).not.toContain("canary-hub");
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const reveal = await as.call("vault_reveal", { itemId: items[0], fields: ["password"], replyKey: Buffer.from(publicKeyOf(secret)).toString("base64") });
  expect(reveal.isError).toBe(false);
  const opened = openSealed(secret, new Uint8Array(Buffer.from((reveal.body as { sealed: string }).sealed, "base64")));
  expect(JSON.parse(Buffer.from(opened!).toString("utf8"))).toEqual({ password: "canary-hub value 1" });
});

test("the whole --areas contract passes on the open hub: each listed tool called, skipped with why, or refused as a run's hub must", async () => {
  const checks = await areasContract(openHub(), contract, (tool, body) => {
    try {
      decodeOutput(tool, body);
      return undefined;
    } catch (e) {
      return String(e);
    }
  }, () => Date.parse("2026-01-02T00:00:00.000Z"));
  expect(checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`)).toEqual([]);
  // Called, not skipped: the ones a run's hub refuses.
  for (const tool of ["github_app_test", "github_app_remove", "doctor_fix", "machine_add_plan", "machine_add", "pair_code_create"]) {
    expect(checks.find((c) => c.name.startsWith(`MCP ${tool} `))?.skipped).toBeUndefined();
  }
});
