import { describe, expect, it } from "vitest";
import type { ActionItem } from "./contracts";
import { actionLabel, activityLabel, browserFailed, commandSaid, mergeSteps, openedTitle, pageName, plainStep, stepLabel, wholeSentences } from "./steps";

const AT = "2026-11-26T10:00:00.000Z";
const action = (a: Partial<ActionItem> & Pick<ActionItem, "kind" | "summary">): ActionItem & { target?: string } => ({ at: AT, status: "completed", failed: false, ...a });

describe("commands in words", () => {
  it.each([
    ["git status", "Checked git status"],
    ["cd /w/app && git status && git log --oneline -5", "Checked git status"],
    ["cd $PWD && bun test test/a.test.ts 2>&1 | tail -20", "Ran the tests"],
    ["pnpm run typecheck", "Checked types"],
    ["npm run build", "Built the app"],
    ["FOO=1 timeout 60 npx vitest run src/x.test.ts", "Ran the tests"],
    ["sed -n 42,70p index.html", "Read `index.html`"],
    ["sed -i 's/a/b/' /home/ada/w/src/index.html", "Edited `index.html`"],
    ["cat > $TMPDIR/notes.md <<'EOF'\n# Notes\nrm -rf /\nEOF", "Wrote `notes.md`"],
    ["python3 - <<'EOF'\nimport os\nEOF", "Ran a script"],
    ["rg -n \"toFixed\" src", "Searched for `toFixed`"],
    ["rg -n 'a|b(c)' src", "Searched the code"],
    ["curl -s https://api.github.com/repos/x/y | jq .", "Fetched `api.github.com`"],
    ["gh pr create --title x --body y", "Opened a PR"],
    ["gh run view 123 --log-failed", "Checked CI"],
    ["mkdir -p shots && cp a.png shots/", "Copied `a.png`"],
    ["sleep 5", "Waited"],
    ["for b in e1 e2; do agent-browser click @$b; done", "Clicked on the page"],
    ["r=$(agent-browser snapshot -i | grep x); agent-browser click @$r", "Clicked on the page"],
    ["ab(){ agent-browser \"$@\" >/dev/null 2>&1; }; ab open https://app.fleetd.dev; ab click @e2", "Opened `app.fleetd.dev`"],
    ["agent-browser set viewport 1440 900 2 && agent-browser open https://en.wikipedia.org/wiki/Web_browser && agent-browser screenshot a.png", "Opened `en.wikipedia.org`"],
    ["agent-browser find role button --name \"Search\" click", "Clicked “Search”"],
    ["agent-browser fill text=Email me@x.dev", "Typed into “Email”"],
    ["agent-browser open file://$PWD/index.html", "Opened a file"],
  ])("%s → %s", (command, words) => {
    expect(commandSaid(command)?.text).toBe(words);
  });

  it("marks machine text (a file, a site, a search) in backticks, for the machine voice; plainStep drops them", () => {
    expect(plainStep("Edited `index.html`")).toBe("Edited index.html");
    // A page by its title is words, not machine text.
    expect(commandSaid("agent-browser open https://en.wikipedia.org/wiki/Web_browser")?.text).toBe("Opened `en.wikipedia.org`");
  });

  it("says it in the present while it runs", () => {
    expect(commandSaid("pnpm test", "present")?.text).toBe("Running the tests");
    expect(commandSaid("agent-browser open https://x.dev", "present")?.text).toBe("Opening `x.dev`");
  });

  it.each([["2>"], ["agent-browser skills get core 2>&1 | head -80"], ["agent-browser --help | grep cdp"], ["which rg"], ["cd /w && export A=1"], ["echo done"], [""]])("%s touched nothing: no step", (command) => {
    expect(commandSaid(command)).toBeUndefined();
  });
});

describe("pages by their names", () => {
  it("names a page by its site's name from the title, else a short title, else its site", () => {
    expect(pageName("Web browser - Wikipedia", "https://en.wikipedia.org/wiki/Web_browser")).toBe("Wikipedia");
    expect(pageName("Pricing · fleetd", undefined)).toBe("fleetd");
    expect(pageName("Sign in", "https://app.fleetd.dev/web")).toBe("Sign in");
    expect(pageName(undefined, "https://www.example.com/a?b")).toBe("example.com");
    expect(pageName("", "about:blank")).toBe("a blank page");
    expect(pageName(undefined, "$URL")).toBeUndefined();
  });

  it("takes the title agent-browser answered an open with", () => {
    expect(openedTitle("✓ Web browser - Wikipedia\n  https://en.wikipedia.org/wiki/Web_browser")).toBe("Web browser - Wikipedia");
    expect(openedTitle("✓ Done")).toBeUndefined();
    expect(openedTitle(undefined)).toBeUndefined();
  });
});

describe("failed only when the step failed", () => {
  it("an open that worked is not failed because a command after it exited 1", () => {
    expect(browserFailed("agent-browser open https://en.wikipedia.org/wiki/Web_browser && rg -q nope page.txt", false, "✓ Web browser - Wikipedia")).toBeUndefined();
    // Its output sent away: the exit is the whole line's, so it says nothing of the open.
    expect(browserFailed("agent-browser open https://x.dev >/dev/null 2>&1; ls missing", false, "Exit code 1")).toBeUndefined();
  });

  it("agent-browser's own ✗ is a failure, with its reason", () => {
    expect(browserFailed("agent-browser click @e9 >/dev/null", false, "✗ Element not found: @e9. Verify the selector")).toBe("failed: Element not found: @e9");
  });

  it("a line that is the one browser command failed when it exited non-zero", () => {
    expect(browserFailed("agent-browser click @e9 2>&1 | tail -1", false, "Exit code 1")).toBe("failed");
    expect(browserFailed("agent-browser click @e9", true, "")).toBeUndefined();
  });
});

describe("an agent's steps", () => {
  it("a command: its words, the whole command to expand, failed when it failed", () => {
    expect(actionLabel(action({ kind: "command", summary: "cd /w && pnpm test" }))).toEqual({ text: "Ran the tests", raw: "cd /w && pnpm test" });
    expect(actionLabel(action({ kind: "command", summary: "pnpm test", failed: true, exitCode: 1 }))).toMatchObject({ text: "Ran the tests", failed: "failed, exit 1" });
    expect(actionLabel(action({ kind: "command", summary: "pnpm test", status: "running" }))).toMatchObject({ text: "Running the tests", running: true });
  });

  it("an edit by the file's name, its path to expand", () => {
    expect(actionLabel(action({ kind: "file_change", summary: "/home/ada/.fleetd/node/worktrees/abc/16e18cf5fa/index.html" }))).toMatchObject({ text: "Edited `index.html`", raw: "/home/ada/.fleetd/node/worktrees/abc/16e18cf5fa/index.html" });
  });

  it("tool calls in words; a tool's own help says nothing", () => {
    expect(actionLabel(action({ kind: "tool_call", summary: "Read", target: "/w/src/style.css" }))?.text).toBe("Read `style.css`");
    expect(actionLabel(action({ kind: "tool_call", summary: "mcp__fleetd__session_start" }))?.text).toBe("Opened a screen");
    expect(actionLabel(action({ kind: "tool_call", summary: "mcp__fleetd__spawn_agent" }))?.text).toBe("Started an agent");
    expect(actionLabel(action({ kind: "tool_call", summary: "mcp__paper__get_screenshot" }))?.text).toBe("Used Paper");
    expect(actionLabel(action({ kind: "tool_call", summary: "WebFetch", target: "https://docs.x.ai/grok" }))?.text).toBe("Read `docs.x.ai`");
    expect(actionLabel(action({ kind: "tool_call", summary: "Skill" }))).toBeUndefined();
    expect(actionLabel(action({ kind: "tool_call", summary: "ToolSearch" }))).toBeUndefined();
  });

  it("a thought whole, never cut mid-word", () => {
    expect(actionLabel(action({ kind: "tool_call", summary: "Thinking: I'm checking the repo state first. Then the helper insi" }))).toEqual({ text: "I'm checking the repo state first.", prose: true });
    expect(wholeSentences("Looking at the helper inside the funct")).toBe("Looking at the helper inside the…");
  });

  it("a start's step or a retry: words already, kept whole", () => {
    const why = "Putting its files on its computer: GitHub refused the clone. Trying again in 300 s, by itself.";
    expect(actionLabel(action({ kind: "other", summary: why, status: "running" }))).toEqual({ text: why, prose: true, running: true });
  });

  it("a message of the agent's as prose", () => {
    expect(stepLabel({ kind: "message", at: AT, id: "m", role: "assistant", text: "Leftover line from the old loop; removing it." })).toEqual({ text: "Leftover line from the old loop; removing it.", prose: true });
  });
});

describe("the lead's step now", () => {
  it("in the present, plain", () => {
    expect(activityLabel({ kind: "edit", path: "src/checkout/rounding.ts" })).toBe("Editing `rounding.ts`");
    expect(activityLabel({ kind: "read", path: "index.html" })).toBe("Reading `index.html`");
    expect(activityLabel({ kind: "command", text: "cd /w && git status" })).toBe("Checking git status");
    expect(activityLabel({ kind: "tool", name: "spawn_agent", server: "fleetd" })).toBe("Starting an agent");
    expect(activityLabel({ kind: "web", detail: "en.wikipedia.org" })).toBe("Reading `en.wikipedia.org`");
    expect(activityLabel({ kind: "thinking" })).toBeUndefined();
  });
});

describe("a list of steps", () => {
  it("merges steps that read as one", () => {
    const spawn = actionLabel(action({ kind: "tool_call", summary: "mcp__fleetd__spawn_agent" }));
    const read = (p: string) => actionLabel(action({ kind: "tool_call", summary: "Read", target: p }));
    const steps = [spawn, spawn, spawn, read("a.ts"), read("b.ts"), read("b.ts")].filter((s) => s !== undefined);
    expect(mergeSteps(steps).map((s) => s.text)).toEqual(["Started 3 agents", "Read 2 files"]);
  });

  it("never merges a failure away", () => {
    const ok = actionLabel(action({ kind: "command", summary: "pnpm test" }));
    const bad = actionLabel(action({ kind: "command", summary: "pnpm test", failed: true }));
    expect(mergeSteps([ok, bad, ok].filter((s) => s !== undefined)).map((s) => s.failed)).toEqual([undefined, "failed", undefined]);
  });
});
