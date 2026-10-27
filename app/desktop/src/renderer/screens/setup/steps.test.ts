import { describe, expect, it } from "vitest";
import type { DoctorCheck } from "../../../shared/contracts";
import { guides, requiredLeft, setupSteps } from "./steps";

const check = (id: string, status: DoctorCheck["status"], message = id): DoctorCheck =>
  id.startsWith("hub/") ? { id, scope: "hub", status, message } : { id, scope: "machine", machineId: id.split("/")[0] ?? "", status, message };

const byId = (steps: ReturnType<typeof setupSteps>) => Object.fromEntries(steps.map((s) => [s.id, s]));

describe("setup steps", () => {
  it("computes the values for this hub: the GitHub App's manifest, Google's redirect only over HTTPS", () => {
    const values = (hub: string, step: string) => guides(hub).find((g) => g.id === step)?.parts.flatMap((p) => p.values ?? []) ?? [];
    expect(values("https://devbox.example.net/", "github").slice(0, 3).map((v) => v.value)).toEqual([
      "fleetd on devbox",
      "https://devbox.example.net",
      "https://devbox.example.net/oauth/github/callback",
    ]);
    const redirect = (hub: string) => values(hub, "google").find((v) => v.label === "Authorized redirect URI");
    expect(redirect("https://devbox.example.net")).toMatchObject({ value: "https://devbox.example.net/oauth/google/callback" });
    expect(redirect("http://devbox:4790")).toMatchObject({ plain: true });
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

  it("keeps a skip only for a step that isn't set up, and counts what is required", () => {
    const checks = [check("hub/reachable", "ok"), check("devbox/online", "ok"), check("hub/notion", "ok")];
    const steps = setupSteps("http://devbox:4790", checks, new Set(["notion", "google"] as const));
    expect(byId(steps)["google"]?.status).toBe("skipped");
    expect(byId(steps)["notion"]?.status).toBe("done");
    expect(requiredLeft(steps)).toBe(1);
    expect(requiredLeft(setupSteps("http://devbox:4790", [...checks, check("hub/claude_key", "ok")]))).toBe(0);
  });
});
