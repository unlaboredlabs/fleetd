import { describe, expect, it } from "vitest";
import type { PrKey } from "../shell/routes";
import { codeRuns, machineCode, prLinks } from "./format";

const href = (pr: PrKey) => `#/prs/${pr.repo ?? "-"}/${String(pr.number)}`;
const linked = (md: string) => prLinks(machineCode(md), href);

describe("PR mentions in chat text", () => {
  it("link #N and PR #N to the project's PR", () => {
    expect(linked("Opened #9 for it.")).toBe("Opened [#9](#/prs/-/9) for it.");
    expect(linked("PR #221 is up (and #222).")).toBe("[PR #221](#/prs/-/221) is up (and [#222](#/prs/-/222)).");
  });

  it("leave other # text as it is: code, words joined to it, entities, #0 and headings", () => {
    for (const md of ["Run `gh pr view #9` first.", "issue#9", "a/#9", "&#9;", "#0", "#9a", "## Next", "```\ngit log --grep #9\n```"]) {
      expect(linked(md)).toBe(machineCode(md));
    }
  });

  it("send a GitHub PR URL to that repo's PR, keeping a sentence's full stop outside the link", () => {
    expect(linked("See https://github.com/acme/storefront/pull/12.")).toBe(
      "See [https://github.com/acme/storefront/pull/12](#/prs/acme/storefront/12).",
    );
    expect(linked("https://github.com/acme/ui.kit/pull/3/files")).toBe("[https://github.com/acme/ui.kit/pull/3/files](#/prs/acme/ui.kit/3)");
    expect(linked("Issue https://github.com/acme/storefront/issues/12")).toBe("Issue https://github.com/acme/storefront/issues/12");
  });

  it("keep a written link's words, and link it once", () => {
    expect(linked("[the fix](https://github.com/acme/storefront/pull/12)")).toBe("[the fix](#/prs/acme/storefront/12)");
    expect(linked("[#9](https://example.com/x)")).toBe("[#9](https://example.com/x)");
    expect(linked("<https://github.com/acme/storefront/pull/12>")).toBe("[https://github.com/acme/storefront/pull/12](#/prs/acme/storefront/12)");
  });

  it("split into text, code and app links for one line", () => {
    expect(codeRuns(linked("Merged #9 after `ci`"))).toEqual([
      { code: false, text: "Merged " },
      { code: false, text: "#9", href: "#/prs/-/9" },
      { code: false, text: " after " },
      { code: true, text: "ci" },
    ]);
    // A link out of the app stays as it was written.
    expect(codeRuns("[docs](https://example.com)")).toEqual([{ code: false, text: "[docs](https://example.com)" }]);
  });
});
