// A call's refusal in Settings' words: what happened and what to do, each its own sentence, never run together.
import { describe, expect, it } from "vitest";
import { CallError } from "../../src/data/queries";
import { errorText } from "./hub";

describe("errorText", () => {
  it("ends what happened with a full stop before what to do", () => {
    const e = new CallError({
      code: "gh_no_access",
      message: "fleetd's GitHub App doesn't reach owner/repo, or there's no such repository",
      fix: "An owner or admin installs fleetd's GitHub App on owner, then adds it again. Or check the name",
    });
    expect(errorText(e)).toBe(
      "fleetd's GitHub App doesn't reach owner/repo, or there's no such repository. An owner or admin installs fleetd's GitHub App on owner, then adds it again. Or check the name.",
    );
  });

  it("keeps a sentence that already ends, and a message with no fix as it is", () => {
    expect(errorText(new CallError({ code: "invalid", message: "That name is taken.", fix: "Pick another?" }))).toBe("That name is taken. Pick another?");
    expect(errorText(new CallError({ code: "invalid", message: "x is not a GitHub repository" }))).toBe("x is not a GitHub repository");
  });
});
