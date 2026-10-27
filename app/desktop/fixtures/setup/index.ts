// The hub admin's setup (screens/setup, a design prototype): a hub `fleetd init` just made on devbox, before and
// after its GitHub App, the Google client next, and the end. The hub answers at an HTTPS address (Tailscale Serve
// in life; a tailnet name counts as a leak here). The checks named hub/claude_key, hub/github_app, hub/people,
// hub/google, hub/notion and hub/onepassword are the ones docs/design/setup.md proposes; "unknown" is "not set up".
import { Fixture, PROTOCOL } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import type { JsonObject } from "../kit/json.ts";

const CHECKED = "2026-10-19T09:01:35.585Z";
const HUB_URL = "https://devbox.example.com";

type Status = "ok" | "warn" | "fail" | "unknown";

const hub = (name: string, status: Status, message: string): JsonObject => ({ id: `hub/${name}`, scope: "hub", status, message });
const devbox = (name: string, status: Status, message: string): JsonObject => ({ id: `devbox/${name}`, scope: "machine", machineId: "devbox", status, message });

/** Right after `fleetd init` on devbox: the hub and its machine are up, every account still to do. */
const fresh = (): Array<JsonObject> => [
  hub("reachable", "ok", `The hub answers at ${HUB_URL}/healthz.`),
  devbox("online", "ok", "devbox is online and its node answers."),
  hub("claude_key", "unknown", "No Claude key on the hub yet, and claude on devbox isn't logged in."),
  hub("github_app", "unknown", "No GitHub App yet: no PR can open and the train can't merge."),
  hub("people", "unknown", "Only you so far."),
  hub("google", "unknown", "Not connected."),
  hub("notion", "unknown", "Not connected."),
  hub("onepassword", "unknown", "Not connected."),
];

const set = (checks: Array<JsonObject>, id: string, status: Status, message: string) =>
  checks.map((c) => (c["id"] === id ? { ...c, status, message } : c));

const withClaude = (checks: Array<JsonObject>) =>
  set(checks, "hub/claude_key", "ok", "The hub's API key answers (key ending …Q2wA, api.anthropic.com).");

const withGitHub = (checks: Array<JsonObject>) =>
  set(checks, "hub/github_app", "ok", "The App \"fleetd on devbox\" is installed on acme with 12 repositories, its token works, and you're connected as dev.");

const NEXT = "Each failing check names the command that fixes it.";

export default defineGroup({
  fixtures: (base) => {
    /** The empty hub (no projects yet) with these checks; `rerun` is what Re-run and Test find. */
    const fromEmpty = (name: string, note: string, checks: Array<JsonObject>, rerun: Array<JsonObject> = checks) => {
      const f = Fixture.from(base("empty"), name, note);
      f.state = { phase: "live", hub: HUB_URL, protocol: PROTOCOL };
      f.drop("doctor_list");
      f.answer("doctor_list", {}, { checkedAt: CHECKED, checks, next: NEXT });
      f.answer("doctor_list", { rerun: true }, { checkedAt: CHECKED, checks: rerun, next: NEXT });
      return f;
    };
    return [
      fromEmpty("setup-fresh", "A hub fleetd init just made on devbox: hub and machine done, every account to do.", fresh()),
      fromEmpty(
        "setup-github",
        "Claude is done; the GitHub App is next, and its Test finds it installed and connected.",
        withClaude(fresh()),
        withGitHub(withClaude(fresh())),
      ),
      fromEmpty("setup-google", "GitHub is done; the Google client is next.", withGitHub(withClaude(fresh()))),
      fromEmpty("setup-done", "Everything required, and GitHub, done; people and integrations left for later.", withGitHub(withClaude(fresh()))),
    ];
  },
});
