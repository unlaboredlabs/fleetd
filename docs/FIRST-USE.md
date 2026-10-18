# First use: fleetd beside the live setup on forge

A runbook for Adri to execute. Adri has SSH to forge as `wynn` (no sudo) and a shell on the Mac. Wynn only opens
the desktop app (step 4); that is where he answers everything.

**Ground rule: nothing in the live setup changes.** That means:
- `t3code.service` stays untouched (the live T3 at `100.104.249.49:3773`, home `~/.t3`);
- the leads Adri runs on it stay untouched;
- CLIProxyAPI on the Mac and Hermes are not modified.

Every step below uses its own ports, directories and unit names, and step 5 removes all of it.

## What runs where

| Thing | Where | Address / path |
|---|---|---|
| Live T3 (untouched, not used by fleetd) | `t3code.service` | `100.104.249.49:3773`, `~/.t3` |
| fleetd hub | `fleetd-hub.service` (systemd user unit) | `127.0.0.1:4790`, home `~/.fleetd/hub`, log `~/.fleetd/hub/hub.log` |
| Hub over HTTPS (desktop app, other machines) | `tailscale serve` (wynn is the tailscale operator, so no sudo is needed) | `https://forge.tailb10092.ts.net` → `127.0.0.1:4790` |
| fleetd node on forge (runs the `claude` sessions) | `fleetd-node.service` | home `~/.fleetd/node`, worktrees `~/.fleetd/node/worktrees`, log `~/.fleetd/logs/node.log` |
| fleetd's Claude config and login | | `~/.fleetd/claude` (`CLAUDE_CONFIG_DIR`), `~/.fleetd/claude.env` (0600) |
| fleetd binary | installed by `fleetd.sh` | `~/.fleetd/bin/fleetd`, linked from `~/.local/bin/fleetd` (not a build from `~/src/fleetd`, which build agents rebuild) |
| First project checkout | | `~/fleetd-work/cliproxyapi-console` (its own clone, not `~/src/cliproxyapi-console`) |

## Decision (2): fleetd's agents stay out of the live setup

fleetd's node runs `claude` itself. It doesn't use T3, so it never talks to `t3code.service` or reads `~/.t3`. Its
sessions use their own config dir (`~/.fleetd/claude`) and their own worktrees under `~/.fleetd/node/worktrees`. The
only things it shares with the live setup are the OS user, the `gh` login and the `claude` binary.

The hub's router and retro run `claude -p` as wynn with his own `~/.claude` login, like any other `claude` run.

## Decision (3): first project is `cliproxyapi-console`

Checked on forge on 2026-10-17:
- in the live setup, the project `cliproxyapi-console` has **no threads**;
- the repo's last commit was 5 days ago;
- it has **0 open PRs**;
- it has a `ci` workflow the merge train can wait on.

`xaq-extensions` is not a good first project. The live agentinbox lead worked on it today (worktrees
`~/src/xaq-ext-b1`, `-b2`, `-c`), and that lead's subagent threads are still idle rather than settled. A fleetd
lead there could collide with it.

**Before step 3, Adri checks the live setups on the Mac and Worldstream for any running lead on
`cliproxyapi-console`.** forge's view can't see them. If one exists, stop here and pick another quiet repo.

Two cautions:
- **The repo is public.** fleetd commits with the GitHub noreply identity (set in step 1).
- **Merged code doesn't touch the running console.** The console Wynn uses on the Mac keeps running its installed
  build until someone redeploys it, so merges are low-stakes.

## Step 0: pre-flight (read-only, about 2 min)

```sh
ssh forge 'systemctl --user is-active t3code.service; ss -H -ltn | grep -E ":(3773|4790)\b"; ls ~/.fleetd 2>&1; tailscale serve status'
```

Expect:
- `active`;
- only `100.104.249.49:3773` listening;
- `~/.fleetd` missing;
- `No serve config`.

If 4790 is taken, pick a free port and use it in every command below (`--listen`, `--hub-url`, `tailscale serve`).

forge has one harmless leftover from testing, a failed unit record. Clear it:

```sh
ssh forge 'systemctl --user reset-failed fleetd-t3-fleetdlab.service 2>/dev/null; true'
```

## Step 1: hub on forge (about 10 min)

Steps 1 to 3 run on forge without a TTY (`ssh -T forge`, or `ssh forge '<command>'`). Without a TTY,
`fleetd init` sets up only the hub and asks nothing.

```sh
# the fleetd binary only (no app on a headless box), checksummed; ~/.local/bin must be on PATH
curl -fsSL https://fleetd.sh | sh -s -- --no-app
fleetd version

# hub as a user service on 127.0.0.1:4790, reached at the HTTPS name
fleetd init --listen 127.0.0.1:4790 --url https://forge.tailb10092.ts.net \
  --git-identity "wynn-dev <66362261+wynn-dev@users.noreply.github.com>"

# publish the hub over HTTPS on the tailnet only (not Funnel, not public)
tailscale serve --bg --https=443 http://127.0.0.1:4790
curl -s https://forge.tailb10092.ts.net/healthz    # expect ok
```

## Step 2: forge as the first worker (about 5 min)

Look first, then run:

```sh
fleetd machine add --local --machine-id forge --tags always-on,linux --hub-url http://127.0.0.1:4790 --dry-run
fleetd machine add --local --machine-id forge --tags always-on,linux --hub-url http://127.0.0.1:4790
```

It checks that `claude` is on PATH and its version is in fleetd's range. Then it creates `~/.fleetd/claude` and an
empty `~/.fleetd/claude.env`, and installs the `fleetd-node` unit. It waits until `forge` is online. There are no
ports and no other installs. Re-running it is safe.

Give fleetd's Claude the same login the live agents use, without printing it. This is Wynn's own proxy base URL
(decision 5). fleetd agents then share his **weekly cap** with the live leads; step 3 sets a low cap.

```sh
python3 - <<'EOF'
import json, os
env = json.load(open(os.path.expanduser("~/.claude/settings.json")))["env"]
p = os.path.expanduser("~/.fleetd/claude.env")
fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, "".join(f"{k}={env[k]}\n" for k in ("ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN")).encode())
os.close(fd); print("written", p)
EOF
systemctl --user restart fleetd-node.service      # fleetd's node only; never t3code.service
```

## Step 3: the first project and its lead (about 10 min)

```sh
git clone https://github.com/wynn-dev/cliproxyapi-console ~/fleetd-work/cliproxyapi-console

# keys: one for Adri (operate), one short-lived admin key for setup
fleetd hub key create --name adri --role operate --machines '*'     # printed once; store it in Adri's secrets
fleetd hub key create --name setup-admin --role admin --machines '*'
```

Add one MCP entry to Adri: `https://forge.tailb10092.ts.net/mcp` with header `Authorization: Bearer fld_…`.

Then, through that MCP:
1. With the admin key:
   - `project_add {machineId: "forge", path: "/home/wynn/fleetd-work/cliproxyapi-console", title: "cliproxyapi-console"}`
     → note the `projectId` it returns;
   - `cap_set {cap: 8}`, the global subagent cap for the first week.
2. `fleetd hub key revoke <setup-admin keyId>`.
3. `lead_start {machineId: "forge", projectId}`. The default lead is `claude-opus-5-5` at effort high.
4. `doctor_list {rerun: true}`. Everything should be ok, in particular:
   - forge's `claude_version`, `claude_login` and `runner_conformance`;
   - `hub/claude_login`, which means the hub's router and retro can reach Claude through wynn's own login.

Optional, and recommended once the first merge works: let only fleetd merge to this repo's `main` by adding a
ruleset on `wynn-dev/cliproxyapi-console` that requires the `fleetd/train` status. That also blocks merges from any
other agent, so only do it while fleetd is the one working on this repo.

## Step 4: the desktop app on Wynn's Mac (Adri installs it; Wynn opens it)

Prerequisite: **Tailscale** on the Mac, logged in to the same tailnet.

```sh
curl -fsSL https://fleetd.sh | sh                 # the app into ~/Applications/fleetd.app, plus the fleetd CLI
ssh forge '~/.local/bin/fleetd pair --name mac'   # a one-time code, valid 15 minutes, and a fleetd://pair link
open ~/Applications/fleetd.app
```

Wynn's part:
1. On the "Connect to your fleetd hub" screen, enter hub address `https://forge.tailb10092.ts.net` and the code.
   Opening the `fleetd://pair` link does the same. Pairing gives this device a human key, which is how the hub
   records answers, approvals and secrets as Wynn's.
2. macOS asks once to store the key in the Keychain, and once to allow notifications. Allow both.

The app then shows Inbox, Projects, Machines and the Doctor. Every ask is answered there: one click or the reply box
for decisions, Approve/Reject on the exact stored command, Copy and ✓ done on checklists, and masked entry for
secrets, which the app seals to the target machine's key before sending. Tool-permission prompts from `claude` that
the project's policy doesn't settle also show up there.

While it runs, a macOS notification appears for things only Wynn can unblock: blocking money, credential and
irreversible asks, unrun approvals, usage breakers, and a machine down with work running. It shows at most one per
20 minutes, and during quiet hours only money and irreversible asks. Clicking one opens the inbox. Notifications
need the `fleetd.app` bundle; the bare binary runs without them.

## The first workstream

Use a small, real defect in cliproxyapi-console, e.g. `intake_submit {text: "fix: <one line>"}`. The hub's router
picks the project with one `claude -p` run.

Watch the full loop:
1. The lead freezes a brief.
2. A writer task runs.
3. A PR is opened with `Source:`.
4. A reviewer runs (M tier).
5. The train merges after CI.
6. The lead claims done, and fleetd's checks pass.

## Step 5: rollback (about 5 min, from forge)

```sh
fleetd machine remove forge --purge           # stops/removes fleetd-node, deletes ~/.fleetd/node, ~/.fleetd/claude and claude.env
fleetd uninstall --purge                      # stops/removes fleetd-hub, deletes ~/.fleetd/hub
tailscale serve --https=443 off
curl -fsSL https://fleetd.sh | sh -s -- --uninstall   # removes the binary and its ~/.local/bin link
rm -rf ~/fleetd-work ~/.fleetd
systemctl --user list-units --all --no-legend | grep fleetd   # expect nothing
systemctl --user is-active t3code.service                     # still active, never touched
```

Elsewhere:
- **Mac:** the Keychain item via the app's "Disconnect and forget key", then
  `curl -fsSL https://fleetd.sh | sh -s -- --uninstall` (removes the app and the CLI).
- **GitHub:** delete the cliproxyapi-console ruleset if you added one. PRs fleetd opened stay as normal PRs.

## What to watch in the first days

- **The doctor.** It's on the desktop app's Machines screen. Anything red has one fix action or an exact command.
- **The weekly cap.** fleetd agents and the live leads draw from the same proxy, so keep `cap_set` low (8) until
  real usage is known.
  - `usage_status` shows pauses.
  - A pause after "pool exhausted" waits for `usage_resume`. For now that is a silent park, not a loud ask (known
    gap below).
- **Memory on forge.** Each live session is its own `claude` process (about 200-300 MB). Idle sessions are reaped,
  and slots cap how many run at once.
- **Lead behaviour on Opus.** Lab runs used haiku, which sometimes skipped steps. Watch for:
  - leads that don't claim done;
  - repeated reviews (refused by fleetd and logged as `polish_loop`);
  - PRs without `Source:`.

  `incidents_list` counts all of these.
- **Lead wake count per workstream.** In the lab most turns were lead wakes, so if that number grows, wakes need
  more batching.
- **Digests** at 09:00 and 18:00 in `policy.tz`. Quiet hours default to 23:00-08:00.
- **Logs:** `~/.fleetd/hub/hub.log` and `~/.fleetd/logs/node.log`. The node keeps each session's raw `claude`
  transcript under `~/.fleetd/node`.

## Untested before first use

- **Desktop notifications on a real Mac.** CI builds and signs the `fleetd.app` bundle, but no notification has been
  shown on a Mac yet; the lab checks the `attention` events and quiet windows they come from.
- **The desktop app on a Mac against a live hub.** It is built in CI on macOS and benched on Linux only. Mac and
  GPU speed numbers are still pending (`app/bench/MAC-RUN.md`).
- **`machine add` against a real second machine.** It was tested on forge itself only.
- **Real Opus leads on real work.** Lab leads ran on haiku.
- **Usage limits on a subscription login.** forge reaches Claude through the proxy, so only the proxy's limit texts
  are tested. The node keeps raw transcripts, so the first real subscription limit can be recorded as a fixture.
- **A Codex reviewer.** fleetd has no Codex runner yet, so L-tier reviews use Claude twice.
- **Self-improvement.** It needs about 2 weeks of real incidents.
