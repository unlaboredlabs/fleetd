# Cutover: Rust to Bun

How the live fleet moves from the Rust fleetd to the Bun/TypeScript one (experimental/bun), one machine at a time,
and how each step goes back. Steps marked **[approval]** change the live fleet: the lead runs them through
`gated_run`, and the human approves each one. Nothing else here touches the live hub or its machines.

## How it works

- **Two flavours, one release.** Each release has the Rust builds (`fleetd-<os>-<arch>`) and, built from the same
  commit with the same version, the Bun builds (`fleetd-bun-linux-x64`, `fleetd-bun-linux-arm64`,
  `fleetd-bun-darwin-arm64`). The Bun macOS build is signed exactly as the Rust one: the same Developer ID (team
  G6U9X94K54), the same identifier (`sh.fleetd.cli`) and the hardened runtime, plus the entitlements Bun needs
  (`allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`). That is what keeps a Mac's Screen
  Recording and Accessibility grants when it switches; signed any other way, every Mac would ask for both again. The
  release build checks it and fails otherwise (build-release.yml, `cli-macos`).
- **The hub's flavour is the fleet's.** `fleetd update` on a machine, and the hub's own update, fetch the running
  build's own flavour. A node its hub updates (Update, automatic updates, a cloud machine's catch-up as it wakes) is
  told the hub's flavour with its version, and a node on the other one switches, as `fleetd update --flavour` does.
  Each node lists its flavour at its hello (`build_rust`, `build_bun`), so one on the other flavour counts as behind
  whatever its version. A node from before flavours names none: it takes its own flavour of the hub's version first,
  then switches at the next update or wake. A machine the release has no build of the hub's flavour for (Bun has
  none for Intel Macs) stays as it is, and its update says why.
- **The switch.** `fleetd update --flavour bun` on a Rust machine installs the release's Bun build at the same path
  (the one its services run: one binary path, never renamed or hard-linked), puts the release's Rust build beside
  it as `fleetd-session-host`, and restarts the services, as any update does. The Bun build hosts its agents'
  sessions under that Rust build, and every Bun update brings it along to the same release.
- **The rollback.** `fleetd update --flavour rust` on a Bun machine installs the release's Rust build at the same
  path and restarts. If the Bun build won't even start, the Rust build beside it is the rollback, with no
  download (below). A Bun update that doesn't come up healthy is rolled back by its watcher as any update is, and
  that puts back the session host too: the update keeps the one it replaces beside the previous build
  (`update/fleetd.prev.session-host`), so the machine is back on one release's pair.
- **New machines.** `curl -fsSL https://fleetd.sh | FLEETD_FLAVOUR=bun sh` installs the Bun build with its session
  host. A cloud machine a hub creates installs the hub's own flavour (hub/cloud/setup.sh passes it).
- **Same database.** Both flavours run the same migration files (crates/fleetd/src/hub/store/migrations; the Bun
  build embeds them) with the same runner and checksums, and the node's `sessions.sqlite` has the same schema in
  both. A rollback to the same release's Rust build never meets a migration it doesn't know.

The devbox runs the hub and its node from one binary (`~/.fleetd/bin/fleetd`), so switching the hub switches the
devbox's node with it.

## Before you start

Nothing here needs approval. Stop if any check fails.

1. **The workstream's other parts are done.** PORT_MAP shows every area ported or waived, Bun CI is green on main,
   the Bun hub polls CI and merges for agents (the train works end to end on a throwaway fleet), and the Bun node
   ran on the agents' Mac (mac sim, Mac screen, grants).
2. **The edge release has Bun builds**, and its run's `cli-macos` job passed (the Bun Mac build signed as the Rust
   one). Its `SHA256SUMS` lists `fleetd-bun-linux-x64` and `fleetd-bun-darwin-arm64`:

   ```sh
   curl -fsSL https://github.com/unlaboredlabs/fleetd/releases/download/edge/SHA256SUMS | grep fleetd-bun-
   ```

3. **Rehearse on a throwaway fleet with that release's builds.** A hub and two nodes with their own homes, switched
   to Bun one by one and back (one node by the offline rollback), checked after each step. It never touches the
   live services:

   ```sh
   cd experimental/bun
   d="$TMPDIR/cutover-builds"; mkdir -p "$d"
   for a in fleetd-linux-x64 fleetd-bun-linux-x64; do
     curl -fsSL -o "$d/$a" "https://github.com/unlaboredlabs/fleetd/releases/download/edge/$a"; chmod +x "$d/$a"
   done
   bun scripts/cutover-lab.ts --rust "$d/fleetd-linux-x64" --bun "$d/fleetd-bun-linux-x64"
   ```

   It ends `cutover-lab: every step passed`.
4. **The live database opens in Bun.** Copy the hub's and the devbox node's databases (SQLite's backup, read-only on
   the live files), check the copies, delete them. Never start a hub on a copy:

   ```sh
   c="$TMPDIR/db-copy"; mkdir -p "$c"
   python3 -I -c 'import sqlite3,sys
   for s,d in zip(sys.argv[1::2], sys.argv[2::2]):
       sqlite3.connect(f"file:{s}?mode=ro", uri=True).backup(sqlite3.connect(d))' \
     ~/.fleetd/hub/hub.sqlite "$c/hub.sqlite" ~/.fleetd/node/sessions.sqlite "$c/sessions.sqlite"
   (cd experimental/bun && bun scripts/db-check.ts "$c/hub.sqlite" "$c/sessions.sqlite")
   rm -rf "$c"
   ```

   It ends `db-check: the Bun build opens these in place`. `would run …` names migrations the live hub hasn't run
   yet (it runs an older build); that's fine as long as the schema after them is the same.
5. **Wake one boat slot from a throwaway Bun hub [approval]** (it uses the human's boat.dev key and starts a VM).
   The Bun hub's SSH tunnel to a cloud machine is tested only against an ssh2 server, never boat's own OpenSSH
   sshd. Start a Bun hub with a FLEETD_HOME of its own, never the live one (`fleetd hub start --home …` from the
   Bun build, FLEETD_HOME set on every fleetd call), and in its Settings › Hub › Machines › Cloud machines save
   the boat key, an environment that exists on the boat account, and one machine; then Create. Check: the slot
   wakes, its setup finishes (`~/fleetd-setup.log` on the VM ends at `done`), it joins the throwaway hub through
   the tunnel and shows online, its `SHA256SUMS` line is `fleetd-bun-linux-x64`, and an agent run on it ends. Then
   `fleetd cloud stop` on the throwaway hub, delete its machine at boat.dev (named `fleetd-<its hub id>-…`), stop
   that hub by its PID, and delete its home. Each hub's machines carry its own hub id as their label, so neither
   hub's stop touches the other's.
6. **Note what runs now**, to compare after each step: the hub's version (Settings › Hub › Updates), each machine's
   status and version (`fleetd_status`), the open orders, the merge train's queue.

## The steps

Each machine's flavour can be read off its binary: the release's `SHA256SUMS` line that matches it names the asset.

```sh
curl -fsSL https://github.com/unlaboredlabs/fleetd/releases/download/edge/SHA256SUMS \
  | grep "$(sha256sum ~/.fleetd/bin/fleetd | cut -d' ' -f1)"   # macOS: shasum -a 256
```

### 0. Hold updates **[approval]**

Turn off Update automatically (Settings › Hub › Updates) for the cutover, so no new build lands between steps.

Rollback: turn it back on.

### 1. The hub (and the devbox's node) **[approval]**

Back up the hub's database first, then switch. On the devbox, through `gated_run`:

```sh
python3 -I -c 'import sqlite3,sys; sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True).backup(sqlite3.connect(sys.argv[2]))' \
  ~/.fleetd/hub/hub.sqlite ~/.fleetd/hub/hub.pre-bun.sqlite
~/.fleetd/bin/fleetd update --flavour bun
```

It says `fleetd <version> (rust) -> <version> (bun)`, `put the Rust build beside it as …/fleetd-session-host`, then
restarts the hub at once and the node once its agents finish their step (10 minutes at most). Running agents carry on
through it.

Checks:

- `curl -fsS <hub url>/healthz` answers, and the hub's `SHA256SUMS` line (above) is `fleetd-bun-linux-x64`.
- Every machine that was online is online again (`fleetd_status`), on its version.
- An agent run end to end: spawn a small task on the devbox (a one-line change in a scratch project) and see it
  start, run a tool, and finish with its result.
- The merge train: an open PR's CI wait resolves and the train takes the next PR in its queue (Status shows it), or
  a trivial PR lands.
- The hub's log (`journalctl --user -u fleetd-hub -n 200`) has no migration or drift errors.

Rollback, from the devbox:

```sh
~/.fleetd/bin/fleetd update --flavour rust
```

If the Bun build won't start at all, put the Rust build beside it back, with no download:

```sh
cp ~/.fleetd/bin/fleetd-session-host ~/.fleetd/bin/.fleetd.new && mv ~/.fleetd/bin/.fleetd.new ~/.fleetd/bin/fleetd
systemctl --user restart fleetd-hub fleetd-node
```

The Rust hub opens the database the Bun hub wrote (rehearsed in step 3). `hub.pre-bun.sqlite` is the last resort
only: restoring it loses everything since step 1.

### 2. The other Linux machines, one by one **[approval each]**

For each machine, through `gated_run` on it:

```sh
~/.fleetd/bin/fleetd update --flavour bun
```

Checks, before the next machine: it's online on its version (`fleetd_status`), its `SHA256SUMS` line is
`fleetd-bun-linux-x64`, and an agent run end to end on it.

Rollback: `~/.fleetd/bin/fleetd update --flavour rust` on it, or the offline copy of `fleetd-session-host` above,
then `systemctl --user restart fleetd-node`.

Cloud machines (Settings › Hub › Machines › Cloud machines): a new one installs the hub's flavour, so once the hub
runs Bun, new ones come up Bun. One made before switches to Bun as it next wakes (its catch-up), or at the next update
while it's awake; nothing to run on it. After a hub rollback they switch back to Rust the same way.

### 3. The agents' Mac, last **[approval]**

Through `gated_run` on the Mac:

```sh
~/.fleetd/bin/fleetd update --flavour bun
```

Checks: it's online, its `SHA256SUMS` line (`shasum -a 256`) is `fleetd-bun-darwin-arm64`, `fleetd node grants`
still shows Accessibility and Screen Recording granted, with no prompt on the Mac's screen (the Bun build is the
same signed program at the same path; `codesign -dvv ~/.fleetd/bin/fleetd` says `Identifier=sh.fleetd.cli` and
`TeamIdentifier=G6U9X94K54`),
`mac sim start` gets a simulator and `mac sim end` frees it, a Mac screen session shows the screen, and an agent run
end to end on it.

Rollback: `~/.fleetd/bin/fleetd update --flavour rust`, or offline:

```sh
cp ~/.fleetd/bin/fleetd-session-host ~/.fleetd/bin/.fleetd.new && mv ~/.fleetd/bin/.fleetd.new ~/.fleetd/bin/fleetd
launchctl kickstart -k "gui/$(id -u)/sh.fleetd.node"
```

(A new file renamed over the path, as every update does; the running binary itself is never renamed or hard-linked.)
If a grant reads lost after either switch, it's the node check's one setup step, on the Mac's screen.

### 4. Updates back on **[approval]**

Turn Update automatically back on. From now on each machine updates to the hub's flavour's builds: the Bun ones, and
the Rust session host beside each with them. A machine still on Rust switches at the first update.

## Rolling everything back

Reverse order: the Mac, the other machines, then the hub, each with its step's rollback. A mixed fleet works at
every point in between (a Bun hub with Rust nodes, and the reverse), so stop wherever things are healthy again. With
the hub back on Rust, the hub's next update (and each cloud machine's next wake) brings every node back to Rust too.
The Rust code stays in the repo, and every release keeps shipping both flavours, until the human says otherwise.
