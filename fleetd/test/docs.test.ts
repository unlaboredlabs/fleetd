// scripts/docs.ts and scripts/setup-fixtures.ts: the docs' generated pages and the app's setup fixtures.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentToolsPage, cliPage, mdText, parseHelp, prose, sourceText, splice, summary } from "../scripts/docs.ts";
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
    expect(mdText("<workspace url>/mcp *a* | b")).toBe("\\<workspace url\\>/mcp \\*a\\* \\| b");
  });

  test("parses the real help", () => {
    const ids = parseHelp(usageText()).flatMap((g) => g.entries.map((e) => e.id));
    for (const id of ["version", "init", "init-join", "machine-add", "pair-worker", "workspace-key-create-human"]) expect(ids).toContain(id);
  });

  test("prose marks machine text", () => {
    const commands = ["pair", "doctor", "workspace"];
    const words = ["pair", "doctor", "workspace", "key", "revoke"];
    expect(
      prose("the command fleetd pair --worker prints, then fleetd doctor. --yes (or ~/.fleetd/hub) and `fleetd node join`", commands, words),
    ).toBe("the command `fleetd pair --worker` prints, then `fleetd doctor`. `--yes` (or `~/.fleetd/hub`) and `fleetd node join`");
    expect(prose("one device: fleetd workspace key revoke <keyId>. The", commands, words)).toBe("one device: `fleetd workspace key revoke` \\<keyId\\>. The");
    expect(prose("replace this fleetd with", commands, words)).toBe("replace this fleetd with");
    expect(prose("print the fleetd doctor", commands, words)).toBe("print the fleetd doctor");
  });

  test("source text shows literally", () => {
    expect(sourceText("done:<n> or `T<n>`, a*")).toBe("done:&lt;n> or `T<n>`, a\\*");
  });

  test("a command's summary is its first sentence", () => {
    expect(summary("set up fleetd (home default ~/.fleetd/hub; kept running): the workspace. Run it again")).toBe(
      "set up fleetd (home default ~/.fleetd/hub; kept running).",
    );
    expect(summary("stop being the agents' Mac")).toBe("stop being the agents' Mac.");
    expect(summary("see `a. b` here and there, then somewhere else. More")).toBe("see `a. b` here and there, then somewhere else.");
    expect(summary("forget it: the workspace's gh goes back to this machine's own login. More")).toBe(
      "forget it: the workspace's gh goes back to this machine's own login.",
    );
  });

  test("every command is on the CLI page", () => {
    const page = cliPage();
    for (const group of parseHelp(usageText())) for (const e of group.entries) expect(page).toContain(`fleetd ${e.synopsis[0]}`);
  });

  test("every tool, blocked tool and switch is on the page", () => {
    const page = agentToolsPage();
    for (const tool of [...toolsFor("lead"), ...toolsFor("worker")]) expect(page).toContain(`<span id="${tool.name}"></span>\`${tool.name}\`: `);
    const blocked = page.split("### Blocked everywhere")[1]!.split("### What a lead")[0]!;
    for (const [tool] of [...DISALLOWED_WHY, ...AGENT_DISALLOWED_WHY, ...TASK_DISALLOWED_WHY, ...LEAD_DISALLOWED_WHY]) {
      expect(blocked).toContain(`\`${tool}\``);
    }
    for (const [[name]] of [...SUBAGENTS_OFF_ENV_WHY, ...SESSION_ENV_WHY, ...DEFAULT_ENV_WHY]) expect(page).toContain(`- \`${name}\` = `);
    const [own, helpers] = PROMPT_CACHE_TTL_VARS;
    const cache = page.split(`- \`${own}\`, \`${helpers}\``)[1]!.split("\n- ")[0]!;
    expect(cache.split("\n  - ").length - 1).toBe(PROMPT_CACHE_TTL_WHY.length);
    // Allowed and blocked never overlap.
    const allowed = page.split("**Allowed:**")[1]!.split("\n")[0]!;
    for (const [tool] of [...DISALLOWED_WHY, ...AGENT_DISALLOWED_WHY]) expect(allowed).not.toContain(`\`${tool}\``);
    expect(allowed).toContain("`Bash`");
    expect(allowed).toContain("`Edit`");
  });
});

test("the app's setup fixtures are the workspace's own answers", () => {
  const saved = readFileSync(join(import.meta.dir, "../../app/desktop/fixtures/setup/steps.json"), "utf8");
  expect(fixtures()).toBe(saved);
});
