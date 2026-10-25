# Desktop app follow-ups

Things a daily user will notice that the design pass left for later. Remove a line when it ships.

- **Full diffs.** The hub doesn't serve a workstream's diff yet. The lead log tints diff output from edits, but it
  only has the last 1 KB of each action's output. The full diff view (`diffview.rs`) is ready for when the hub
  serves diffs.
- **Unread survives a restart.** Unread dots count from when the app connected. Everything that was already there
  when it launched counts as seen.
- **Selecting text with the mouse.** Commands, errors and codes have Copy buttons, but you can't drag-select text
  in asks or the lead log.
- **Paths on other machines.** Clicking a file path opens it when the file is on this computer. When it's on another
  machine, the app copies the path instead.
- **Threads in the palette.** ⌘K finds a project's threads only after that project's details have loaded.
- **Jump to an ask.** A notification or a palette hit marks the ask in the inbox, but a long inbox doesn't scroll
  to it yet.
- **Add a project from the app.** With no projects, the board and sidebar point at `fleetd init` on the hub. The
  hub already has `project_add`; an "Add project…" action (a machine and a path) in the composer's project picker
  and the empty state would save the trip to a terminal.
- **Unverified on a Mac.** The system font, SF Mono with its Menlo fallback, and Match system following the OS live
  were all checked on Linux only.
- **Slow reconnect after quick hub bounces.** Mac QA (a hub restart, then 3 quick bounces): one run had not
  reconnected 20 s after the last bounce. The backoff only starts over after a link stays ready for `STABLE_MS`
  (30 s, `app/desktop/src/main/hub/client.ts:280`), so each short-lived link keeps growing it toward the 30 s cap
  (`protocol.ts:50`), plus up to 25 % jitter, so a wait of up to ~37 s. Deciding how fast a link that reached ready
  may retry, without hammering a hub that accepts and drops, is a design call.

# Hub and CLI follow-ups

- **`fleetd init --help` exit code** (in progress, wizard). It prints the usage but exits 2 instead of 0.
- **`fleetd init` lists failures twice** (in progress, wizard). The closing "step(s) need you" list repeats the ✗ lines
  above it.

# Before a second runner

The hub, train and app talk to a runner only through `node/runner/mod.rs`: `Runner` (spawn, profile → model and
effort), `RunnerGuide` (the words and commands a person reads), classified tool calls (`ToolClass`) and
provider-neutral `RunUsage`. What still assumes Claude, and what a GPT or Grok runner needs first. Remove a line when
it ships.

- **The session service writes claude's files** (`node/sessions/mod.rs:168` `runner_env`, `:202` `prompt_cache_env`,
  `:279` `mcp_config` with `alwaysLoad`, `:305` `settings_overlay`, `:1536` `spec`). A second runner needs
  `Runner::prepare(spec, dir)` that writes its own config from a neutral spec (role, fleetd's MCP server as a command
  and env, denies) and owns its cache policy.
- **Resume is claude's session file** (`node/sessions/state.rs:180`, `node/store.rs:64-69` `cwd`/`config_dir`,
  `node/worktree.rs:2`). Another runner keeps its conversation elsewhere (a rollout file, a server-side id): it needs
  `Runner::resumable(spec)` and an opaque `runner_ref` on the session row. The fixed worktree path can stay a node rule.
- **Ids follow claude's protocol** (`fleetd-contracts/src/sessions.rs:50-66`): the thread id is passed as
  `--session-id`, the run id as the user-message uuid. The ids stay fleetd's; a runner maps them onto its own.
- **Tool rules are claude's syntax** (`fleetd-contracts/src/sessions.rs:69-74`, `tasks.rs:262`,
  `hub/executor/mod.rs:1328`): `Bash(npm test:*)`. A GPT runner can't read them; it needs neutral categories (shell
  prefix, file write, MCP server) that each runner maps, or a "full access only" answer.
- **Steering is claude's stream-json queue** (`fleetd-contracts/src/sessions.rs:150,301-337`,
  `node/runner/mod.rs:158-176` `Joined`/`Seen`/`SendNow`/`Withdrawn`). Another CLI may have no mid-turn queue: it needs
  `RunnerInfo` capabilities (`steer_now`, `withdraw`) and the fallbacks (interrupt at the next tool boundary, then a new
  turn).
- **Usage windows are claude.ai's** (`fleetd-contracts/src/node_link.rs:119-151`, `node/runner/mod.rs` `RateLimit`,
  `hub/usage/state.rs:512` window names, app `screens/projects/machineText.ts:36,65`). The shape fits ChatGPT plans
  too; the names and the "claude" label need the runner's own words.
- **One runner per node** (`node/mod.rs:184` `ClaudeRunner`, `:55` `--claude-config-dir`). The one place a runner is
  chosen; it becomes a map of `RunnerKind` to runner, and the config dir a per-runner setting. The hub's prompt page
  (`hub/prompts/store.rs`) uses the default runner's denied tools since it doesn't keep a session's runner.
- **Setup installs and checks claude** (`cli/setup/wizard.rs:21-22`, `cli/setup/machine.rs:22`,
  `cli/setup/machine_plan.rs:12`, `cli/setup/doctor.rs`). Setup needs a step per runner; the app's check labels
  (`screens/projects/SetupChecks.tsx:21-22`) are keyed by the claude check ids.
- **The bench measures Anthropic only** (`tests/lab/bench/accounting.ts:37-42` with the `ephemeral_5m`/`1h` split,
  Opus prices, the proxy, `~/.claude/projects` session files; `tests/lab/{noSubagents,chatLead}.ts` on
  `mcp__fleetd__*`). fleetd's own `RunUsage` has no cache-TTL split. A GPT run needs a provider adapter in the harness:
  price table, usage mapper, session-file reader.
- **The agent tools page is claude's** (`docsgen/src/agent_tools.rs:44`, `what-agents-are-told.md`): "Claude Code shows
  them as `mcp__{server}__<tool>`". Generate it per runner.
