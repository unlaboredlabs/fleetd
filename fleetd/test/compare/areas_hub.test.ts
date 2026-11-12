// `--areas`'s seeds (tests/compare/areas.ts) on the open hub itself, not a stand-in: every module's tools served over
// /mcp, with a vault, called through the suite's own seed with a person's admin key. A seed the hub refuses (as the
// vault's personal env item was, once the hub kept one team vault) fails here, not only in a run of the suite by hand.
// And the vault seed's mark sits where only a reveal shows it, so the two-team cases' canary keeps its meaning.
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import mcpToolsText from "../../../app/desktop/src/shared/contracts/schema/McpTools.json" with { type: "text" };
import { seed } from "../../../tests/compare/areas.ts";
import { openSession } from "../../../tests/compare/mcp.ts";
import type { Team } from "../../../tests/compare/target.ts";
import { serve, stop } from "../../src/hub/http/index.ts";
import { people } from "../../src/hub/people/store.ts";
import { build } from "../../src/hub/serve/index.ts";
import { vault } from "../../src/hub/vault/index.ts";
import { openSealed, publicKeyOf } from "../../src/shared/sealed_box_core.ts";
import { hubHome } from "../helpers.ts";

const contract = JSON.parse(mcpToolsText);
const home = hubHome();
const { hub, tools } = build(home.dir, { host: "127.0.0.1", port: 0 });
// The vault's key in the test's home, not beside it (a hub's own goes in the folder above its home).
vault(hub, { dir: join(home.dir, "vault"), scryptN: 1024 });
const owner = people(hub).ensureOwner();
const server = serve(hub, tools, 0);
afterAll(async () => {
  await stop(server);
  hub.shutdown.abort();
  hub.db.close();
  home.done();
});

const team: Team = {
  url: `http://127.0.0.1:${server.port}`,
  key: async ({ name }) => hub.auth.keys.createKeyFor(name, [{ role: "admin", machines: "*" }], "human", owner.personId).key,
  enrol: async () => {
    throw new Error("no machine joins an --areas run");
  },
};

test("every seed of --areas the hub lists is one the open hub takes, and the vault's mark shows only in a reveal", async () => {
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
