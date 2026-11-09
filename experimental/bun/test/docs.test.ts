// scripts/docs.ts and scripts/setup-fixtures.ts: the docs' generated pages and the app's setup fixtures.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentToolsPage, checkExample, clean, mdText, parseHelp, patternWords, prose, sourceText, splice } from "../scripts/docs.ts";
import { fixtures } from "../scripts/setup-fixtures.ts";
import { usageText } from "../src/cli/index.ts";
import { toolsFor } from "../src/cli/agent_mcp/tools.ts";
import {
  AGENT_DISALLOWED_WHY, DEFAULT_ENV_WHY, DISALLOWED_WHY, LEAD_DISALLOWED_WHY, PROMPT_CACHE_TTL_WHY, SESSION_ENV_WHY,
  SUBAGENTS_OFF_ENV_WHY, TASK_DISALLOWED_WHY,
} from "../src/node/runner/claude/explained.ts";
import { PROMPT_CACHE_TTL_VARS } from "../src/node/runner/claude.ts";

describe("docs", () => {
  test("splice replaces only the region", () => {
    expect(splice("a\n<!-- t -->\nold\n<!-- /t -->\nb\n", "t", "new\n")).toBe("a\n<!-- t -->\n\nnew\n\n<!-- /t -->\nb\n");
    expect(() => splice("a\n", "t", "x")).toThrow();
  });

  test("md text escapes markup", () => {
    expect(mdText("<hub url>/mcp *a* | b")).toBe("\\<hub url\\>/mcp \\*a\\* \\| b");
  });

  test("parses the real help", () => {
    const ids = parseHelp(usageText()).flatMap((g) => g.entries.map((e) => e.id));
    for (const id of ["version", "init", "init-join", "machine-add", "pair-worker", "hub-key-create-human"]) expect(ids).toContain(id);
  });

  test("prose marks machine text", () => {
    const commands = ["pair", "doctor", "hub"];
    const words = ["pair", "doctor", "hub", "key", "revoke"];
    expect(
      prose("the command fleetd pair --worker prints, then fleetd doctor. --yes (or ~/.fleetd/hub) and `fleetd node join`", commands, words),
    ).toBe("the command `fleetd pair --worker` prints, then `fleetd doctor`. `--yes` (or `~/.fleetd/hub`) and `fleetd node join`");
    expect(prose("one device: fleetd hub key revoke <keyId>. The", commands, words)).toBe("one device: `fleetd hub key revoke` \\<keyId\\>. The");
    expect(prose("replace this fleetd with", commands, words)).toBe("replace this fleetd with");
    expect(prose("print the fleetd doctor", commands, words)).toBe("print the fleetd doctor");
  });

  test("source text shows literally", () => {
    expect(sourceText("done:<n> or `T<n>`, a*")).toBe("done:&lt;n> or `T<n>`, a\\*");
  });

  test("schema words", () => {
    expect(patternWords("^T[1-9][0-9]*$")).toBe("`T<n>`, e.g. `T1`.");
    expect(clean("`--item P<n>`: the plan item this task works on")).toBe("The plan item this task works on.");
    expect(clean("A [`Brief`] whose")).toBe("A `Brief` whose.");
    expect(clean("M9: a research judge")).toBe("A research judge.");
    expect(clean("https://github.com/<owner>/<name>/pull/<n>")).toBe("Like `https://github.com/<owner>/<name>/pull/<n>`.");
  });

  test("an example with a key the schema lacks is refused", () => {
    const tool = toolsFor("lead").find((t) => t.name === "agents")!;
    expect(() => checkExample("lead", tool, { taskId: "T1", taskID: "T1" })).toThrow(/taskID/);
    expect(() => checkExample("lead", tool, { taskId: "seven" })).toThrow();
  });

  test("every blocked tool and switch is on the page", () => {
    const page = agentToolsPage();
    const blocked = page.split("**Blocked**")[1]!;
    for (const [tool] of DISALLOWED_WHY) expect(blocked).toContain(`\`${tool}\``);
    for (const [[name]] of [...SUBAGENTS_OFF_ENV_WHY, ...SESSION_ENV_WHY, ...DEFAULT_ENV_WHY]) expect(page).toContain(`| \`${name}\` |`);
    const [own, helpers] = PROMPT_CACHE_TTL_VARS;
    expect(page.split(`| \`${own}\`, \`${helpers}\` |`).length - 1).toBe(PROMPT_CACHE_TTL_WHY.length);
    // Allowed and blocked never overlap.
    const allowed = page.split("**Allowed:**")[1]!.split("\n")[0]!;
    for (const [tool] of DISALLOWED_WHY) expect(allowed).not.toContain(`\`${tool}\``);
    for (const [tool] of [...AGENT_DISALLOWED_WHY, ...TASK_DISALLOWED_WHY, ...LEAD_DISALLOWED_WHY]) expect(blocked).toContain(`\`${tool}\``);
    expect(allowed).toContain("`Bash`");
    expect(allowed).toContain("`Edit`");
  });
});

test("the app's setup fixtures are the hub's own answers", () => {
  const saved = readFileSync(join(import.meta.dir, "../../../app/desktop/fixtures/setup/steps.json"), "utf8");
  expect(fixtures()).toBe(saved);
});
