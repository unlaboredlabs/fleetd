// The join installs Claude Code on a machine with none (S2): it refused such a machine, and Get started asks about
// Claude only in the step after the join.
import { expect, test } from "bun:test";
import { Checklist } from "../../src/cli/setup/checklist.ts";
import { CLAUDE_TESTED } from "../../src/cli/setup/machine_plan.ts";
import { ensureClaude } from "../../src/cli/setup/wizard.ts";

const quiet = () => {
  const list = new Checklist();
  list.rich = false;
  return list;
};

test("a machine with Claude Code joins as it is: nothing installed", async () => {
  let installs = 0;
  const list = quiet();
  expect(await ensureClaude(list, { find: () => "/usr/local/bin/claude", install: () => (installs++, Promise.resolve({ ok: true, said: "" })) })).toBe(true);
  expect(installs).toBe(0);
  expect(list.items).toEqual([]);
});

test("a machine without it gets it from Claude's installer, at the tested version, then joins", async () => {
  let there: string | undefined;
  const list = quiet();
  const ok = await ensureClaude(list, { find: () => there, install: () => ((there = "/home/sam/.local/bin/claude"), Promise.resolve({ ok: true, said: "" })) });
  expect(ok).toBe(true);
  expect(list.items).toEqual([{ title: "Installing Claude Code", state: "done", detail: `${CLAUDE_TESTED}: fleetd runs its agents through it` }]);
});

test("an install that failed says why and the line to run, and the join stops before it is refused", async () => {
  const list = quiet();
  const ok = await ensureClaude(list, { find: () => undefined, install: () => Promise.resolve({ ok: false, said: "curl: (6) Could not resolve host: claude.ai" }) });
  expect(ok).toBe(false);
  expect(list.items[0]).toMatchObject({ state: "failed", detail: "curl: (6) Could not resolve host: claude.ai", fix: "run curl -fsSL https://claude.ai/install.sh | bash, then paste the join line again" });
});
