import { describe, expect, it } from "vitest";
import type { ProjectSettings } from "../../../shared/contracts";
import { deleteConfirmed } from "../projects/RemoveProjectDialog";
import { countAfter, nameProblem, parseDotEnv, shownValue, unsavedWorktrees, valueProblem, withKind } from "./projectModel";
import { parseRoute } from "./route";
import { searchSettings } from "./search";

const AT = "2026-10-19T10:00:00.000Z";

describe("Settings → Projects", () => {
  it("reads a pasted .env: comments, export, quotes and a later line winning", () => {
    const vars = parseDotEnv(
      [
        "# local",
        "",
        "export DATABASE_URL=postgres://localhost/app",
        "API_URL = https://staging.example # the staging one",
        `GREETING="hello\\nworld"`,
        "RAW='a # not a comment'",
        "STRIPE_KEY=sk_old",
        "STRIPE_KEY=sk_test_42",
        "not a line",
        "1BAD=x",
        "FLEETD_THREAD_ID=x",
      ].join("\r\n"),
    );
    const byName = Object.fromEntries(vars.map((v) => [v.name, v]));
    expect(vars.map((v) => v.name)).toEqual(["DATABASE_URL", "API_URL", "GREETING", "RAW", "STRIPE_KEY", "1BAD", "FLEETD_THREAD_ID"]);
    expect(byName["DATABASE_URL"]).toMatchObject({ value: "postgres://localhost/app", kind: "plain", problem: null });
    expect(byName["API_URL"]?.value).toBe("https://staging.example");
    expect(byName["GREETING"]?.value).toBe("hello\nworld");
    expect(byName["RAW"]?.value).toBe("a # not a comment");
    // Credentials start as secrets.
    expect(byName["STRIPE_KEY"]).toMatchObject({ value: "sk_test_42", kind: "secret", problem: null });
    expect(byName["1BAD"]?.problem).toBeTruthy();
    expect(byName["FLEETD_THREAD_ID"]?.problem).toContain("fleetd sets");
  });

  it("checks a secret is one line, and lets a plain value hold more", () => {
    const greeting = parseDotEnv(`GREETING="hello\\nworld"`)[0];
    if (greeting === undefined) throw new Error("not parsed");
    expect(greeting.problem).toBeNull();
    expect(withKind(greeting, "secret").problem).toBe("A secret is one line.");
    expect(valueProblem("", "plain")).toBeNull();
    expect(valueProblem("", "secret")).toBeTruthy();
    expect(valueProblem("é".repeat(4097), "plain")).toBeTruthy();
    expect(nameProblem("PATH")).toBeTruthy();
    expect(nameProblem("_ok_1")).toBeNull();
  });

  it("shows a secret by fingerprint, never a value", () => {
    expect(shownValue({ name: "K", kind: "secret", fingerprint: "ab12cd34", updatedAt: AT })).toBe("secret · ab12cd34");
    expect(shownValue({ name: "U", kind: "plain", value: "x", updatedAt: AT })).toBe("x");
    expect(countAfter([{ name: "K", kind: "plain", value: "", updatedAt: AT }], ["K", "L"])).toBe(2);
  });

  it("names the worktrees a delete loses work in, and confirms only on the exact name", () => {
    const settings: ProjectSettings = {
      machineId: "devbox",
      projectId: "p1",
      title: "storefront",
      workspaceRoot: "/w",
      keepWorktrees: false,
      env: [],
      worktrees: {
        dir: "/h/worktrees/p1",
        worktrees: [
          { sessionId: "a", path: "/h/worktrees/p1/a", uncommitted: true },
          { sessionId: "b", path: "/h/worktrees/p1/b", uncommitted: false },
        ],
      },
    };
    expect(unsavedWorktrees(settings).map((w) => w.sessionId)).toEqual(["a"]);
    expect(deleteConfirmed(" storefront ", "storefront")).toBe(true);
    expect(deleteConfirmed("Storefront", "storefront")).toBe(false);
    expect(deleteConfirmed("", "")).toBe(false);
  });

  it("links to one project's settings and finds them by the words people use", () => {
    expect(parseRoute("#/settings/projects?for=devbox/p1")).toMatchObject({ tab: "projects", for: "devbox/p1" });
    expect(searchSettings("env")[0]?.key).toBe("projects.env");
    expect(searchSettings("secrets").map((o) => o.key)).toContain("projects.env");
    expect(searchSettings("delete project")[0]?.key).toBe("projects.delete");
  });
});
