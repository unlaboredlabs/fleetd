# First use: fleetd beside the live setup on forge

A runbook for Adri to execute. Adri has SSH to forge as `wynn` (no sudo) and a shell on the Mac. Wynn only pairs
his phone (step 5) and opens the desktop app (step 4).

**Ground rule: nothing in the live setup changes.** That means:
- `t3code.service` stays untouched (T3 at `100.104.249.49:3773`, home `~/.t3`);
- the leads Adri runs on it stay untouched;
- CLIProxyAPI on the Mac and Hermes are not modified.

Every step below uses its own ports, directories and unit names, and step 6 removes all of it.

## What runs where

| Thing | Where | Address / path |
|---|---|---|
| Live T3 (untouched) | `t3code.service` | `100.104.249.49:3773`, `~/.t3` |
| fleetd hub | `fleetd-hub.service` (systemd user unit) | `127.0.0.1:4790`, home `~/.fleetd/hub`, log `~/.fleetd/hub/hub.log` |
| Hub over HTTPS (phone, desktop, other machines) | `tailscale serve` (wynn is the tailscale operator, so no sudo is needed) | `https://forge.tailb10092.ts.net` → `127.0.0.1:4790` |
| fleetd's own T3 on forge | `fleetd-t3.service` | `127.0.0.1:3774`, home `~/.fleetd/t3` |
| fleetd node on forge | `fleetd-node.service` | home `~/.fleetd/node`, log `~/.fleetd/logs/node.log` |
| fleetd's Claude config and login | | `~/.fleetd/claude`, `~/.fleetd/t3.env` (0600) |
| fleetd binaries on the worker | | `~/.local/share/fleetd/{cli,bin,npm}` |
| fleetd source the hub runs from | | `~/opt/fleetd` (a clean clone; not `~/src/fleetd`, which build agents rebuild) |
| First project checkout | | `~/fleetd-work/cliproxyapi-console` (its own clone, not `~/src/cliproxyapi-console`) |

## Decision (2): give fleetd its own T3 on forge, don't adopt the live one

**Run a second T3 owned by fleetd.** `fleetd machine add` does this by default. Adopting the live T3 is not safe,
for four reasons:

1. **fleetd configures the T3 it drives.** It denies T3's own spawn tools (`--disallowedTools
   mcp__t3-code__*,Task,Workflow`), turns off T3's auto-resume, and points Claude at its own config dir. On the
   live T3 that would change how Adri's current leads behave, and the settings only take effect after a restart.
2. **The node mints and revokes sessions in that T3's database.** That means writing to `~/.t3/userdata`, which
   is off-limits.
3. **The node restarts its T3 when health checks fail, and the doctor's fix button restarts it too.** On the live
   T3 that kills every in-flight run of Adri's leads.
4. **The hub would see every live thread and project.** Its sweep, watchdog and project pruning would act on work
   it doesn't own.

A separate T3 on `127.0.0.1:3774` with home `~/.fleetd/t3` shares nothing with the live one but the OS user, the
`gh` login and the `claude` binary.

## Decision (3): first project is `cliproxyapi-console`

Checked on forge on 2026-10-17:
- the live T3 project `cliproxyapi-console` has **no threads**;
- the repo's last commit was 5 days ago;
- it has **0 open PRs**;
- it has a `ci` workflow the merge train can wait on.

`xaq-extensions` is not a good first project. The live agentinbox lead worked on it today (worktrees
`~/src/xaq-ext-b1`, `-b2`, `-c`), and that lead's subagent threads are still idle rather than settled. A fleetd
lead there could collide with it.

**Before step 3, Adri checks its other T3 servers (Mac, Worldstream) for any running lead on `cliproxyapi-console`.**
forge's view can't see them. If one exists, stop here and pick another quiet repo.

Two cautions:
- **The repo is public.** fleetd commits with the GitHub noreply identity (set in step 2).
- **Merged code doesn't touch the running console.** The console Wynn uses on the Mac keeps running its installed
  build until someone redeploys it, so merges are low-stakes.

## Step 0: pre-flight (read-only, about 2 min)

```sh
ssh forge 'systemctl --user is-active t3code.service; ss -H -ltn | grep -E ":(3773|3774|4790)\b"; ls ~/.fleetd 2>&1; tailscale serve status'
```

Expect:
- `active`;
- only `100.104.249.49:3773` listening;
- `~/.fleetd` missing;
- `No serve config`.

If 3774 or 4790 is taken, pick free ports and use them in every command below (`--listen`, `--t3-port`).

forge has one harmless leftover from testing, a failed unit record. Clear it:

```sh
ssh forge 'systemctl --user reset-failed fleetd-t3-fleetdlab.service 2>/dev/null; true'
```

## Step 1: hub on forge (about 10 min)

```sh
ssh forge
# a clean copy of fleetd at a known commit, built once
git clone https://github.com/wynn-dev/fleetd ~/opt/fleetd && cd ~/opt/fleetd && git checkout 9260d10
corepack enable --install-directory ~/.local/bin pnpm 2>/dev/null || true
pnpm install --frozen-lockfile && pnpm build
alias fleetd="node $HOME/opt/fleetd/apps/cli/dist/bin.js"

# hub as a user service on 127.0.0.1:4790; the pairing link will use the HTTPS name
fleetd init --listen 127.0.0.1:4790 --url https://forge.tailb10092.ts.net \
  --git-identity "wynn-dev <66362261+wynn-dev@users.noreply.github.com>" --name phone
# init prints a one-time phone pairing link (15 min). Note it but don't send it yet; step 5 makes a fresh one.

# publish the hub over HTTPS on the tailnet only (not Funnel, not public)
tailscale serve --bg --https=443 http://127.0.0.1:4790
curl -s https://forge.tailb10092.ts.net/healthz    # expect ok
```

## Step 2: forge as the first worker, with its own T3 (about 10 min)

`machine add` works over SSH, even for forge itself. Let forge SSH to itself once:

```sh
grep -qF "$(cut -d' ' -f2 ~/.ssh/id_ed25519.pub)" ~/.ssh/authorized_keys || cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys
ssh-keyscan -H localhost >> ~/.ssh/known_hosts
ssh -o BatchMode=yes localhost true && echo self-ssh ok
```

Look first, then run:

```sh
fleetd machine add localhost --machine-id forge --tags always-on,linux --t3-port 3774 --hub-url http://127.0.0.1:4790 --dry-run
fleetd machine add localhost --machine-id forge --tags always-on,linux --t3-port 3774 --hub-url http://127.0.0.1:4790
```

It installs:
- T3 `0.1.1-nightly.20261017.3238` into `~/.local/share/fleetd/npm`;
- the node;
- the fleetd Claude instance;
- the `fleetd-t3` and `fleetd-node` units.

It then waits until `forge` is online. Re-running is safe.

Give fleetd's Claude instance the same login the live agents use, without printing it. This is Wynn's own proxy
base URL (decision 5). fleetd agents then share his **weekly cap** with the live leads; step 3 sets a low cap.

```sh
python3 - <<'EOF'
import json, os
env = json.load(open(os.path.expanduser("~/.claude/settings.json")))["env"]
p = os.path.expanduser("~/.fleetd/t3.env")
fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, "".join(f"{k}={env[k]}\n" for k in ("ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN")).encode())
os.close(fd); print("written", p)
EOF
systemctl --user restart fleetd-t3.service      # fleetd's T3 only; never t3code.service
```

## Step 3: the first project and its lead (about 10 min)

```sh
git clone https://github.com/wynn-dev/cliproxyapi-console ~/fleetd-work/cliproxyapi-console
~/.local/share/fleetd/npm/bin/t3 project add ~/fleetd-work/cliproxyapi-console --title cliproxyapi-console --base-dir ~/.fleetd/t3

# keys: one for Adri (operate), one short-lived admin key for the cap
fleetd hub key create --name adri --role operate --machines '*'     # printed once; store it in Adri's secrets
fleetd hub key create --name setup-admin --role admin --machines '*'
```

Add one MCP entry to Adri: `https://forge.tailb10092.ts.net/mcp` with header `Authorization: Bearer fld_…`.

Then, through that MCP:
1. `cap_set {cap: 8}` with the admin key; this is the global subagent cap for the first week.
2. `fleetd hub key revoke <setup-admin keyId>`.
3. `projects_list` → note the `projectId` of cliproxyapi-console on `forge`.
4. `lead_start {machineId: "forge", projectId}`. The default lead is `claude-opus-5-5` at effort high.
5. `doctor_list {rerun: true}`. Everything should be ok except push, which needs step 5. `hub/claude_login`
   must be ok: it means the hub's router and retro can reach Claude through the `claude` login in
   `~/.claude/settings.json`.

Optional, and recommended once the first merge works: let only fleetd merge to this repo's `main`. Re-run
`scripts/testbed.ts`'s ruleset step by hand against `wynn-dev/cliproxyapi-console`, or add a ruleset requiring
the `fleetd/train` status. That also blocks merges from any other agent, so only do it while fleetd is the one
working on this repo.

## Step 4: the desktop app on Wynn's Mac (Adri builds it; Wynn opens it)

Prerequisites:
- **Command Line Tools:** `xcode-select -p`; if missing, `xcode-select --install`. Full Xcode is not needed:
  Metal shaders compile at runtime.
- **Rust 1.98 or newer:** `rustc --version`; if missing, install rustup per user.
- **Tailscale** on the Mac, logged in to the same tailnet.

```sh
git clone https://github.com/wynn-dev/fleetd ~/src/fleetd && cd ~/src/fleetd && git checkout 9260d10
app/macos-bundle.sh                               # builds release (several minutes the first time) into app/target/release/fleetd.app
# make a key for this device on forge, printed once:
ssh forge 'node ~/opt/fleetd/apps/cli/dist/bin.js hub key create --human --name mac'
open app/target/release/fleetd.app
```

Wynn's part:
1. In the app's connect screen, enter hub URL `https://forge.tailb10092.ts.net` and the `--human` key. A human key
   is how the hub records answers, approvals and secrets as Wynn's; there is no other pairing.
2. macOS asks once to store the key in the Keychain, and once to allow notifications. Allow both.

The app then shows Inbox, Projects, Machines and the Doctor. Every ask is answered there: one click or the reply box
for decisions, Approve/Reject on the exact stored command, Copy and ✓ done on checklists, and masked entry for
secrets, which the app seals to the target machine's key before sending. While it runs, things only Wynn can unblock
(blocking money, credential and irreversible asks, unrun approvals, usage breakers, a machine down with work running)
raise a macOS notification, at most one per 20 minutes and only money/irreversible ones during quiet hours. Clicking
one opens the inbox. Notifications need the `fleetd.app` bundle; the bare binary runs without them.

## Step 5: pair the phone (Wynn, about 2 min)

1. Adri runs `fleetd hub device add --name iphone --url https://forge.tailb10092.ts.net` on forge and sends Wynn
   the link. It works once, within 15 min.
2. On the iPhone, with Tailscale connected, Wynn opens the link in Safari and taps Share → Add to Home Screen.
3. He opens fleetd from the home screen. iOS only allows push for home-screen web apps.
4. He taps **Enable push** and allows notifications.

The device now appears in `fleetd hub key list` as a human key.

## The first workstream

Use a small, real defect in cliproxyapi-console, e.g. `intake_submit {text: "fix: <one line>"}`. The hub's router
picks the project with one `claude -p` run, using the same login as the `claude` CLI of the user the hub runs as. The
doctor's `hub/claude_login` check shows whether that login works.

Watch the full loop:
1. The lead freezes a brief.
2. A writer task runs.
3. A PR is opened with `Source:`.
4. A reviewer runs (M tier).
5. The train merges after CI.
6. The lead claims done, and fleetd's checks pass.

## Step 6: rollback (about 5 min, from forge)

```sh
alias fleetd="node $HOME/opt/fleetd/apps/cli/dist/bin.js"
fleetd machine remove forge --purge-t3        # stops/removes fleetd-node + fleetd-t3, deletes ~/.fleetd/t3, ~/.fleetd/claude, t3.env, ~/.local/share/fleetd
fleetd uninstall --purge                      # stops/removes fleetd-hub, deletes ~/.fleetd/hub
tailscale serve --https=443 off
rm -rf ~/opt/fleetd ~/fleetd-work ~/.fleetd
# undo the self-SSH line added in step 2 (only if you added it):
sed -i "\|$(cut -d' ' -f2 ~/.ssh/id_ed25519.pub)|d" ~/.ssh/authorized_keys
systemctl --user list-units --all --no-legend | grep fleetd   # expect nothing
systemctl --user is-active t3code.service                     # still active, never touched
```

Elsewhere:
- **Mac:** delete `~/src/fleetd`, and the Keychain item via the app's "Disconnect and forget key".
- **Phone:** remove the home-screen app.
- **GitHub:** delete the cliproxyapi-console ruleset if you added one. PRs fleetd opened stay as normal PRs.

## What to watch in the first days

- **The doctor.** It's in the phone app and the desktop Machines screen. Anything red has one fix action or an
  exact command.
- **The weekly cap.** fleetd agents and the live leads draw from the same proxy, so keep `cap_set` low (8) until
  real usage is known.
  - `usage_status` shows pauses.
  - A pause after "pool exhausted" waits for `usage_resume`. For now that is a silent park, not a loud ask (known
    gap below).
- **Lead behaviour on Opus.** Lab runs used haiku, which sometimes skipped steps. Watch for:
  - leads that don't claim done;
  - repeated reviews (refused by fleetd and logged as `polish_loop`);
  - PRs without `Source:`.

  `incidents_list` counts all of these.
- **Lead wake count per workstream.** In the lab most turns were lead wakes, so if that number grows, wakes need
  more batching.
- **Digests** at 09:00 and 18:00 in `policy.tz`. Quiet hours default to 23:00-08:00.
- **Logs:** `~/.fleetd/hub/hub.log` and `~/.fleetd/logs/{node,t3}.log`.

## Untested before first use

- **Push to a real phone.** iOS web push from a real Apple push service has never run. The lab used a mock
  endpoint.
- **The desktop app on a Mac against a live hub.** It is built in CI on macOS and benched on Linux only. Mac and
  GPU speed numbers are still pending (`app/bench/MAC-RUN.md`).
- **`machine add` against a real second machine.** It was tested as same-user emulation on forge.
- **Real Opus leads on real work.** Lab leads ran on haiku.
- **A Codex reviewer.** No Codex instance exists, so L-tier reviews use Claude twice.
- **Self-improvement.** It needs about 2 weeks of real incidents.
