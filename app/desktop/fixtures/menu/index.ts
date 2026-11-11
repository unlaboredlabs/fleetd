// The menu under your name (screens/shell/You.tsx, W607), a fixture per thing it can say beside "all is well" (which
// admin-owner and admin-member show): a setup step left, a machine offline, the hub out of reach, a second hub that
// refused this app's key, an update going on, one just in, one that didn't go in (as the owner, who can try again,
// and as a member, who is told who to ask), and everything at once. Each is Sam's hub (fixtures/admin) with one
// thing changed, so the menu's shots differ only in what they are about.
import { answerHub, bob, sam } from "../admin/index.ts";
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { isObject, type JsonObject, type JsonValue } from "../kit/json.ts";
import { arr } from "../kit/stress.ts";
import steps from "../setup/steps.json" with { type: "json" };

const OLDER = "0.6.0-edge.202610201030+1c0ffee";
const NEXT = "0.6.0-edge.202610231030+9e07d31";

/** The setup steps of a hub with Claude still to log in: one required step left. */
const setupLeft = (f: Fixture): void => {
  const guides = steps.guides as unknown as ReadonlyArray<JsonObject & { readonly id: string }>;
  const fresh = steps.scenarios["setup-fresh"] as unknown as { readonly requiredLeft: number; readonly list: Readonly<Record<string, JsonObject>> };
  f.answer("setup_list", undefined, { steps: guides.map((g) => ({ ...g, ...fresh.list[g.id] })), requiredLeft: fresh.requiredLeft });
};

/** `machineId` offline, in the snapshot and in the live feed, whose word is the newer one. */
const offline = (f: Fixture, machineId: string): void => {
  const off = (machines: JsonValue | undefined) => arr(machines).map((m) => (isObject(m) && m["machineId"] === machineId ? { ...m, status: "offline" } : m));
  if (f.snapshot !== undefined) f.snapshot["machines"] = off(f.snapshot["machines"]);
  f.live = f.live.map((frame) => ({ ...frame, machines: off(frame["machines"]) }));
};

/** The hub's own word on its update (the snapshot's `update`): going on, just in, or put back on buildbox. */
const update = (f: Fixture, state: "updating" | "updated" | "put_back"): void => {
  const ago = (ms: number) => new Date(Date.parse(f.now) - ms).toISOString();
  if (f.snapshot === undefined) return;
  f.snapshot["update"] = {
    runId: "U1792000000000",
    from: OLDER,
    to: NEXT,
    startedAt: ago(5 * 60_000),
    ...(state === "updating" ? {} : { finishedAt: ago(3 * 60_000) }),
    state,
    hub: "done",
    machines: [
      { machineId: "devbox", name: "devbox", state: "done" },
      { machineId: "buildbox", name: "buildbox", state: state === "updating" ? "restarting" : state === "updated" ? "done" : "rolled_back" },
    ],
    ...(state === "put_back" ? { message: "buildbox didn't come up healthy on the new build" } : {}),
  };
};

export default defineGroup({
  fixtures: (base) => {
    const hub = (what: string, note: string, me: JsonObject = sam): Fixture => answerHub(Fixture.from(base("chat-empty"), `menu-${what}`, note), me, me === sam);
    const made = (what: string, note: string, change: (f: Fixture) => void, me?: JsonObject): Fixture => {
      const f = hub(what, note, me);
      change(f);
      return f;
    };
    return [
      made("setup", "Sam's hub with one required setup step left: the menu's line, and Finish.", setupLeft),
      made("machine-offline", "Sam's hub with buildbox offline: the menu names it, and Open goes to its page.", (f) => offline(f, "buildbox")),
      made("offline", "Sam's hub stops answering once the app is open: Can't reach devbox, and Retry.", (f) => {
        f.later(300, "state", { phase: "retrying", hub: f.state.phase === "live" ? f.state.hub : "", reason: "Nothing is listening at devbox:4790", fix: "Start the hub on that machine (`fleetd doctor` there says why it's down).", retryAt: Date.parse(f.now) + 25_000 });
      }),
      made("refused", "Two hubs, Personal and Acme; Acme refused this app's key: Pair again.", (f) => {
        f.label = "Personal";
        f.color = "green";
        const acme = Fixture.from(base("status-rows"), "menu-refused-acme", "Acme's hub, which refused this app's key.");
        acme.state = { phase: "refused", hub: "https://hub.acme.example", message: "This key was revoked" };
        f.hubs = [{ label: "Acme", color: "amber", fixture: acme }];
      }),
      made("updating", "Sam's hub updating: it runs the new build, buildbox restarts onto it.", (f) => update(f, "updating")),
      made("updated", "Sam's hub and its machines updated themselves three minutes ago.", (f) => update(f, "updated")),
      made("update-failed", "The hub updated, and buildbox was put back on its old build: Sam can try again.", (f) => update(f, "put_back")),
      made("member-update-failed", "The same update as Bob, a member: he is told who to ask.", (f) => update(f, "put_back"), bob),
      made("member-no-machine", "Bob, a member, with every machine offline: nothing of his runs, and he is told who to ask.", (f) => {
        offline(f, "devbox");
        offline(f, "buildbox");
      }, bob),
      made("everything", "Everything at once, as Sam: an update that didn't go in, a machine offline, a setup step left.", (f) => {
        update(f, "put_back");
        offline(f, "buildbox");
        setupLeft(f);
      }),
    ];
  },
});
