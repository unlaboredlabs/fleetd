import { describe, expect, it } from "vitest";
import type { ProjectSettings } from "../../../shared/contracts";
import { deleteConfirmed } from "../projects/RemoveProjectDialog";
import { countAfter, nameProblem, parseDotEnv, shownValue, totalProblem, unsavedWorktrees, valueProblem, withKind } from "./projectModel";
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
    expect(byName["FLEETD_THREAD_ID"]?.problem).toContain("a project can't set it");
  });

  it("takes values of any number of lines up to 64 KiB, plain or secret", () => {
    const greeting = parseDotEnv(`GREETING="hello\\nworld"`)[0];
    if (greeting === undefined) throw new Error("not parsed");
    expect(greeting.problem).toBeNull();
    expect(withKind(greeting, "secret").problem).toBeNull();
    expect(valueProblem("", "plain")).toBeNull();
    expect(valueProblem("", "secret")).toBeTruthy();
    expect(valueProblem("x".repeat(64 * 1024), "secret")).toBeNull();
    // 2 bytes a character: one past 64 KiB.
    expect(valueProblem("é".repeat(32 * 1024) + "x", "plain")).toBe("A value is at most 64 KiB.");
    expect(valueProblem("a\0b", "plain")).toBeTruthy();
    expect(nameProblem("PATH")).toBeTruthy();
    expect(nameProblem("_ok_1")).toBeNull();
  });

  it("shows a secret by fingerprint, never a value", () => {
    expect(shownValue({ name: "K", kind: "secret", fingerprint: "ab12cd34", bytes: 9, updatedAt: AT })).toBe("secret · ab12cd34");
    expect(shownValue({ name: "U", kind: "plain", value: "x", bytes: 1, updatedAt: AT })).toBe("x");
    expect(countAfter([{ name: "K", kind: "plain", value: "", bytes: 0, updatedAt: AT }], ["K", "L"])).toBe(2);
  });

  it("reads a quoted value over several lines: a certificate chain, a service account's JSON", () => {
    const chain = "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nMIIBrDCCAVKgAwIBAgIU\n-----END CERTIFICATE-----";
    const json = '{\n  "type": "service_account",\n  "private_key": "-----BEGIN PRIVATE KEY-----\\nMIIE\\n-----END PRIVATE KEY-----\\n"\n}';
    const vars = parseDotEnv([`TLS_CHAIN="${chain}" # the staging chain`, "AFTER=1", `SA_JSON='${json}'`, "LAST=2", 'OPEN="never closed', "tail"].join("\n"));
    const byName = Object.fromEntries(vars.map((v) => [v.name, v]));
    expect(vars.map((v) => v.name)).toEqual(["TLS_CHAIN", "AFTER", "SA_JSON", "LAST", "OPEN"]);
    expect(byName["TLS_CHAIN"]?.value).toBe(chain);
    expect(byName["AFTER"]?.value).toBe("1");
    // '…' keeps a JSON's own \n escapes as they are.
    expect(byName["SA_JSON"]?.value).toBe(json);
    expect(byName["LAST"]?.value).toBe("2");
    expect(byName["OPEN"]?.value).toBe("never closed\ntail");
    expect(vars.every((v) => v.problem === null)).toBe(true);
  });

  it("holds a project's values to 512 KiB together, naming the total", () => {
    const env = [
      { name: "A", kind: "secret" as const, fingerprint: "ab12cd34", bytes: 300 * 1024, updatedAt: AT },
      { name: "B", kind: "plain" as const, value: "b", bytes: 1, updatedAt: AT },
    ];
    const big = "x".repeat(212 * 1024);
    expect(totalProblem(env, [{ name: "C", value: big }])).toBe("A project's variables take at most 512 KiB together; these would take 513 KiB.");
    // Replacing or removing one frees its share.
    expect(totalProblem(env, [{ name: "A", value: big }])).toBeNull();
    expect(totalProblem(env, [{ name: "C", value: big }], ["B"])).toBeNull();
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
