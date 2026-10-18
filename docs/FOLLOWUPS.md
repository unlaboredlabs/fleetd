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
- **Unverified on a Mac.** The system font, SF Mono with its Menlo fallback, and Match system following the OS live
  were all checked on Linux only.
