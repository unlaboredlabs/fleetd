// A writer's Bash rules (`--disallowedTools`) against claude's own matching: a rule's `*` matches any text, quotes,
// heredocs and newlines included, a trailing ` *` that is the only `*` also matches the bare command, and claude tries
// a rule on each part of a chain and at times on the whole chain. Every suffix after a separator stands in for a part here, the strictest reading.
// (claude 2.1.314 against a fake API refused and passed each command below the same way.)
import { expect, test } from "bun:test";
import { ALWAYS_DISALLOWED, roleDisallowed } from "../../src/node/runner/claude.ts";

const RULES = [...ALWAYS_DISALLOWED, ...roleDisallowed("worker")].flatMap((r) => r.match(/^Bash\((.*)\)$/s)?.slice(1) ?? []);
const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
const glob = (rule: string) => new RegExp(`^${rule.split("*").map(escape).join("[^]*")}$`);
const parts = (cmd: string) => [cmd, ...[...cmd.matchAll(/[;&|(`\n]/g)].map((m) => cmd.slice(m.index + 1).trimStart())];
const matches = (rule: string, part: string) => glob(rule).test(part) || (rule.indexOf("*") === rule.length - 1 && rule.endsWith(" *") && part === rule.slice(0, -2));
const refused = (cmd: string) => RULES.filter((r) => parts(cmd).some((p) => matches(r, p)));

const BODY = `A node its hub updates takes the hub's flavour, so a machine stops staying on Rust.

- **Nodes report their flavour.** The hub's update logic counts a node on the other flavour as behind.

🤖 Generated with [Claude Code](https://claude.com/claude-code)`;

test("a chained push and PR with a heredoc body passes, as do routine commands that only mention claude", () => {
  for (const cmd of [
    // T2729's push (12:25 UTC, Nov 9): `*sh -*c *claude*` took "sh -" from `push -q` and "claude" from the body.
    `cd /home/dev/worktrees/devbox-task; git push -q -u origin HEAD 2>&1 | tail -2; gh pr create --base main --title "fix(bun,node,hub): a node takes the hub's flavour (W535)" --body "$(cat <<'EOF'\n${BODY}\nEOF\n)" 2>&1 | tail -1`,
    `git fetch -q origin main && git log --oneline HEAD..origin/main | head; git push -q -u origin fleetd/T1-x 2>&1 | tail -3; gh pr create --fill --body "$(cat <<'EOF'\n${BODY}\nEOF\n)"`,
    `git commit -qm "$(cat <<'EOF'\nfix(bun): a fresh -c flag for bash -c\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nEOF\n)" && git push -q`,
    "ls ~/.claude/projects | head; cat ~/.local/bin/claude >/dev/null",
    "ls ~/.local/share/claude/versions | tail -1",
    "npm view @anthropic-ai/claude-code version",
    "rg -l claude src | xargs grep -n claude_accounts",
    "env CI=1 bun test test/node/claude-setup.test.ts 2>&1 | tail -5",
    "bash -c 'cat ~/.claude/settings.json | head'",
    "git push -q -u origin HEAD 2>&1 | tail -2",
  ]) {
    expect({ cmd, refused: refused(cmd) }).toEqual({ cmd, refused: [] });
  }
});

test("a nested claude is still refused, however it is spelled", () => {
  for (const cmd of [
    "claude -p hi",
    "claude",
    "cd /tmp && claude --version",
    "echo $(claude -p hi)",
    "bash -c 'claude -p hi'",
    'bash -lc "cd /tmp && claude --resume x"',
    "sh -c 'claude -p hi'",
    "env FOO=1 claude -p hi",
    "exec claude -p hi",
    "echo x | xargs -n1 claude -p",
    "~/.local/bin/claude -p hi",
    "$HOME/.local/bin/claude -p hi",
    "/home/dev/.local/bin/claude --print hi",
    "./node_modules/.bin/claude -p hi",
    "pnpm dlx @anthropic-ai/claude-code -p hi",
    "/bin/zsh -c 'cd /w && claude -p hi'",
    "/home/dev/.local/share/claude/versions/2.1.314 -p hi",
    "npx @anthropic-ai/claude-code -p hi",
    "bunx -y @anthropic-ai/claude-code@latest -p hi",
    "npx claude -p hi",
  ]) {
    expect({ cmd, refused: refused(cmd).length > 0 }).toEqual({ cmd, refused: true });
  }
});

test("a writer still can't push past the pre-push check", () => {
  for (const cmd of ["git push --no-verify", "cd x; git push -q --no-verify origin HEAD", "git -c core.hooksPath=/dev/null push"]) {
    expect({ cmd, refused: refused(cmd).length > 0 }).toEqual({ cmd, refused: true });
  }
});
