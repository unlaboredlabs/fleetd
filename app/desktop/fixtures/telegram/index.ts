// A Navi's Telegram (Settings → Projects → the Navi), one fixture per setup step. telegram-start: no bot yet, so
// steps 1 and 2 are open (@BotFather's messages, the sealed token field). telegram-tested: the token saved and
// tested, Pair with Telegram next (its link answered, for the waiting state). telegram-paired: paired and connected.
// telegram-retrying: paired, Telegram asked it to slow down.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { arr } from "../kit/stress.ts";
import { asText, isObject, type JsonObject } from "../kit/json.ts";
import { profilesList } from "../settings/profiles.ts";

const AT = "2026-10-31T09:00:00.000Z";

/** Marks the first project a Navi, Ada, and returns its ref. */
const navi = (f: Fixture): { machineId: string; projectId: string } => {
  const projects = arr(f.snapshot?.["projects"]).filter(isObject);
  const first = projects[0];
  if (first === undefined) throw new Error("telegram fixtures: the base has no project");
  first["kind"] = "assistant";
  first["title"] = "Ada";
  const ref = { machineId: asText(first["machineId"]), projectId: asText(first["projectId"]) };
  f.answer("project_settings_get", ref, {
    settings: {
      ...ref,
      title: "Ada",
      workspaceRoot: "/home/dev/navi/ada",
      setup: { commands: [], timeoutSec: 600, runAnyway: false, inputs: [] },
      env: [],
      worktrees: { dir: `/home/dev/.fleetd/node/worktrees/${ref.projectId}`, baseBranch: "main", worktrees: [] },
    },
  });
  f.answer("mcp_servers_get", { project: ref }, { global: [], project: [], userServers: true });
  f.answer("navi_purchases", ref, { purchases: [] });
  f.answer("navi_approvals", ref, { approvals: { mode: "checker", model: "claude-sonnet-5-5", effort: "medium", defaults: true }, log: [] });
  f.answer("profiles_list", {}, profilesList());
  return ref;
};

const bot = { id: 7001, username: "ada_fleetd_bot", name: "Ada" };
const saved = { fingerprint: "7e1e9a00", savedAt: AT };
const paired = { userId: 42, name: "Sam Rivera", username: "samrivera", pairedAt: AT };

const step = (base: Fixture, name: string, note: string, bridge: JsonObject | undefined): Fixture => {
  const f = Fixture.from(base, `telegram-${name}`, note);
  const ref = navi(f);
  f.answer("telegram_get", { navi: ref }, bridge === undefined ? {} : { bridge });
  f.answer("telegram_test", { navi: ref }, { bot });
  f.answer("telegram_pair", { navi: ref }, { link: "https://t.me/ada_fleetd_bot?start=Pa1rC0deFromTheHub", expiresAt: "2026-10-31T09:15:00.000Z" });
  return f;
};

export default defineGroup({
  fixtures: (base) => [
    step(base("typical"), "start", "A Navi with no Telegram yet: @BotFather's steps and the token field.", undefined),
    step(base("typical"), "tested", "The token saved and tested: the bot's name, then Pair with Telegram.", { ...saved, bot, status: { state: "connected", since: AT } }),
    step(base("typical"), "paired", "Paired with Sam's account, connected.", { ...saved, bot, paired, status: { state: "connected", since: AT } }),
    step(base("typical"), "retrying", "Paired, and Telegram asked it to slow down: retrying.", {
      ...saved,
      bot,
      paired,
      status: { state: "retrying", since: AT, error: "Telegram asked to slow down for 30 s.", errorAt: AT, retryAt: "2026-10-31T09:00:30.000Z" },
    }),
  ],
});
