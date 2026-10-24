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
