// The menu under your name (screens/shell/You.tsx, W607), a fixture per thing it can say beside "all is well" (which
// admin-owner and admin-member show): a setup step left, a machine offline, the hub out of reach, a second hub that
// refused this app's key, an update going on, one just in, one that didn't go in (as the owner, who can try again,
// and as a member, who is told who to ask, as when no machine is online or every one is degraded), everything at once,
// and hubs and a machine with the longest names, whose rows cut the name short and never what is wrong. Each is Sam's
// hub (fixtures/admin) with one thing changed, so the menu's shots differ only in what they are about.
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

/** A label as long as a hub's can be (40 characters), and a machine's name as long. */
const LONG_HUB = "Acme Robotics shared build hub, Berlin 2";
const LONG_OTHER = "Personal projects and garden experiments";
const LONG_MACHINE = "buildbox-ci-runner-eu-central-berlin-002";

/** `machineId` changed by `change`, in the snapshot and in the live feed, whose word is the newer one. */
const machine = (f: Fixture, machineId: string, change: JsonObject): void => {
  const set = (machines: JsonValue | undefined) => arr(machines).map((m) => (isObject(m) && m["machineId"] === machineId ? { ...m, ...change } : m));
  if (f.snapshot !== undefined) f.snapshot["machines"] = set(f.snapshot["machines"]);
  f.live = f.live.map((frame) => ({ ...frame, machines: set(frame["machines"]) }));
};

/** `machineId` offline. */
const offline = (f: Fixture, machineId: string): void => machine(f, machineId, { status: "offline" });

/** `machineId` connected, but its claude can't run. */
const degraded = (f: Fixture, machineId: string): void => machine(f, machineId, { status: "degraded" });

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
      made("member-degraded", "Bob, a member, with every machine connected but degraded: none can run agents, and Bob is told who to ask.", (f) => {
        degraded(f, "devbox");
        degraded(f, "buildbox");
      }, bob),
      made("long-refused", "Two hubs with 40-character labels, one with a long-named machine offline, the other refusing this app's key: the names are cut short, never what is wrong.", (f) => {
        f.label = LONG_OTHER;
        f.color = "green";
        machine(f, "buildbox", { name: LONG_MACHINE, status: "offline" });
        const acme = Fixture.from(base("status-rows"), "menu-long-refused-acme", "A hub with a 40-character label, which refused this app's key.");
        acme.state = { phase: "refused", hub: "https://hub.acme.example", message: "This key was revoked" };
        f.hubs = [{ label: LONG_HUB, color: "amber", fixture: acme }];
      }),
      made("long-offline", "Two hubs with 40-character labels; the second can't be reached: its name is cut short, Retry and the words stay whole.", (f) => {
        f.label = LONG_OTHER;
        f.color = "green";
        const acme = Fixture.from(base("status-rows"), "menu-long-offline-acme", "A hub with a 40-character label, out of reach.");
        acme.state = { phase: "retrying", hub: "https://hub.acme.example", reason: "The hub didn't answer: connection refused", fix: "Check you're on Acme's network or VPN.", retryAt: Date.parse(f.now) + 25_000 };
        f.hubs = [{ label: LONG_HUB, color: "amber", fixture: acme }];
      }),
      made("everything", "Everything at once, as Sam: an update that didn't go in, a machine offline, a setup step left.", (f) => {
        update(f, "put_back");
        offline(f, "buildbox");
        setupLeft(f);
      }),
    ];
  },
});
