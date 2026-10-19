import { describe, expect, it } from "vitest";
import type { DoctorCheck } from "../../../shared/contracts";
import { codeRuns } from "./HubText";
import { checkLabel, groupChecks } from "./SetupChecks";

describe("hub text", () => {
  it("sets backticked commands as code and never shows the backticks", () => {
    expect(codeRuns("On devbox, run `gh auth login` with an account that can read acme/secret")).toEqual([
      { code: false, text: "On devbox, run " },
      { code: true, text: "gh auth login" },
      { code: false, text: " with an account that can read acme/secret" },
    ]);
    expect(codeRuns("`a` and `b`").filter((r) => r.code).map((r) => r.text)).toEqual(["a", "b"]);
    expect(codeRuns("an unclosed ` stays")).toEqual([{ code: false, text: "an unclosed ` stays" }]);
    expect(codeRuns("plain")).toEqual([{ code: false, text: "plain" }]);
  });
});

describe("setup checks", () => {
  const check = (id: string, machineId?: string): DoctorCheck => ({
    id,
    scope: machineId === undefined ? "hub" : "machine",
    ...(machineId === undefined ? {} : { machineId }),
    status: "ok",
    message: "fine",
  });

  it("names checks in words, never by id", () => {
    expect(checkLabel("hub/gh_auth")).toBe("GitHub CLI login");
    expect(checkLabel("devbox/claude_login")).toBe("Claude login");
    expect(checkLabel("devbox/some_new_check")).toBe("Some new check");
  });

  it("groups the hub's checks first, then each machine's by name, in the hub's order", () => {
    const groups = groupChecks([check("hub/https"), check("devbox/disk", "devbox"), check("hub/gh_auth"), check("devbox/online", "devbox")], (id) => `${id}-name`);
    expect(groups.map((g) => [g.title, g.checks.map((c) => c.id)])).toEqual([
      ["Hub", ["hub/https", "hub/gh_auth"]],
      ["devbox-name", ["devbox/disk", "devbox/online"]],
    ]);
  });
});
