import { describe, expect, it } from "vitest";
import type { DoctorCheck } from "../../../shared/contracts";
import { guides, requiredLeft, setupSteps } from "./steps";

const check = (id: string, status: DoctorCheck["status"], message = id): DoctorCheck =>
  id.startsWith("hub/") ? { id, scope: "hub", status, message } : { id, scope: "machine", machineId: id.split("/")[0] ?? "", status, message };

const byId = (steps: ReturnType<typeof setupSteps>) => Object.fromEntries(steps.map((s) => [s.id, s]));

describe("setup steps", () => {
  it("computes the values for this hub: the GitHub App's manifest, and Google's client", () => {
    const values = (hub: string, step: string) => guides(hub).find((g) => g.id === step)?.parts.flatMap((p) => p.values ?? []) ?? [];
    const value = (hub: string, step: string, label: string) => values(hub, step).find((v) => v.label === label);
    expect(values("http://devbox:4790/", "github").slice(0, 3).map((v) => v.value)).toEqual([
      "fleetd on devbox",
      "http://devbox:4790",
      "http://devbox:4790/oauth/github/callback",
    ]);
    // Webhooks only where GitHub can reach the hub; a plain-HTTP tailnet hub polls.
    expect(value("http://devbox:4790", "github", "Webhooks")).toMatchObject({ plain: true });
    expect(value("https://devbox.example.net", "github", "Webhooks")).toMatchObject({ value: "https://devbox.example.net/webhooks/github" });
    // A Desktop app client works on any hub, with the loopback redirect the app listens on, and the hub's exact scopes.
    expect(value("http://devbox:4790", "google", "Application type")?.value).toBe("Desktop app");
    expect(value("https://devbox.example.net", "google", "Redirect URI")?.value).toBe("http://127.0.0.1");
    expect(value("http://devbox:4790", "google", "Draft and send")?.value).toBe("https://www.googleapis.com/auth/gmail.compose");
    expect(value("http://devbox:4790", "google", "Drive")?.value).toBe("https://www.googleapis.com/auth/drive");
    // Gmail in real time is optional: a topic Gmail's push account may publish to, and a pull subscription.
    const google = guides("http://devbox:4790").find((g) => g.id === "google");
    expect(google?.parts.find((p) => p.title === "Gmail in real time")?.optional).toBe(true);
    expect(value("http://devbox:4790", "google", "Publisher on the topic")?.value).toBe("gmail-api-push@system.gserviceaccount.com");
    // ...and a service account that may only read the subscription, whose JSON key is sealed to one machine (#743).
    expect(value("http://devbox:4790", "google", "Subscriber on the subscription")?.value).toBe("fleetd-gmail-reader@fleetd-devbox.iam.gserviceaccount.com");
    const shell = value("http://devbox:4790", "google", "Or in Cloud Shell")?.value ?? "";
    expect(shell).toContain("--role=roles/pubsub.publisher");
    expect(shell).toContain("subscriptions add-iam-policy-binding fleetd-gmail-hub");
    expect(shell).toContain("--role=roles/pubsub.subscriber");
    // Nothing to paste on the setup page: the client and the key are saved, sealed, in Administration › Google.
    expect(google?.fields).toEqual([]);
    expect(google?.savedIn?.hash).toBe("#/admin/google");
  });

  it("reads each status from its checks: none or unknown is to do, the worst failing one wants a look", () => {
    const steps = byId(
      setupSteps("http://devbox:4790", [
        check("hub/reachable", "ok"),
        check("hub/https", "warn", "No HTTPS address."),
        check("devbox/online", "ok"),
        check("buildbox/online", "ok"),
        check("hub/claude_key", "unknown"),
        check("devbox/claude_login", "unknown"),
        check("hub/github_app", "ok"),
      ]),
    );
    expect(steps["address"]).toMatchObject({ status: "look", said: "No HTTPS address." });
    expect(steps["machines"]?.status).toBe("done");
    expect(steps["claude"]?.status).toBe("todo");
    expect(steps["github"]?.status).toBe("done");
    expect(steps["notion"]?.status).toBe("todo");
  });

  it("takes Claude as done any way: the hub's key or the owner's subscription with machines logged out, or every machine's own login", () => {
    const claude = (...checks: ReadonlyArray<DoctorCheck>) => byId(setupSteps("http://devbox:4790", checks))["claude"];
    const out = (machine: string) => check(`${machine}/claude_login`, "fail", `claude is logged out on ${machine}`);
    const ok = (machine: string) => check(`${machine}/claude_login`, "ok");
    // The hub's key: machines need no login of their own.
    expect(claude(check("hub/claude_key", "ok"), out("devbox"), out("buildbox"))).toMatchObject({ status: "done", way: "the hub's API key" });
    // No key: done once every machine is logged in, and not while one isn't.
    expect(claude(check("hub/claude_key", "unknown"), ok("devbox"), ok("buildbox"))).toMatchObject({ status: "done", way: "every machine's own login" });
    expect(claude(check("hub/claude_key", "unknown"), ok("devbox"), out("buildbox"))).toMatchObject({
      status: "look",
      way: "every machine's own login",
      said: "claude is logged out on buildbox",
    });
    // A key that fails wants a look, unless the machines' logins already do the job.
    expect(claude(check("hub/claude_key", "fail", "The key was revoked."), out("devbox"))).toMatchObject({ status: "look", said: "The key was revoked." });
    expect(claude(check("hub/claude_key", "fail"), ok("devbox"))).toMatchObject({ status: "done", way: "every machine's own login" });
    // No key: the owner's subscription, tested, is enough with machines logged out; one that failed its Test wants a look.
    const noKey = check("hub/claude_key", "unknown");
    expect(claude(noKey, check("hub/claude_owner", "ok"), out("devbox"))).toMatchObject({ status: "done", way: "the hub owner's subscription" });
    expect(claude(noKey, check("hub/claude_owner", "fail", "Sam Rivera's Claude subscription failed its Test on devbox."), out("devbox"))).toMatchObject({
      status: "look",
      said: "Sam Rivera's Claude subscription failed its Test on devbox.",
    });
    // Neither set up yet.
    expect(claude(check("hub/claude_key", "unknown"), check("hub/claude_owner", "unknown"))).toMatchObject({ status: "todo" });
    expect(claude(check("hub/claude_key", "unknown"))).not.toHaveProperty("way");
  });

  it("keeps a skip only for a step that isn't set up, and counts what is required", () => {
    const checks = [check("hub/reachable", "ok"), check("devbox/online", "ok"), check("devbox/claude_login", "fail"), check("hub/notion", "ok")];
    const steps = setupSteps("http://devbox:4790", checks, new Set(["notion", "google"] as const));
    expect(byId(steps)["google"]?.status).toBe("skipped");
    expect(byId(steps)["notion"]?.status).toBe("done");
    expect(requiredLeft(steps)).toBe(1);
    expect(requiredLeft(setupSteps("http://devbox:4790", [...checks, check("hub/claude_key", "ok")]))).toBe(0);
  });
});
