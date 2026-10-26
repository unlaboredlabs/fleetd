# The app's design rules

The desktop app follows these rules. The values live in `tokens.css`; this page says how to use them. A change that
breaks a rule changes this page in the same PR and says why.

## Layout and separation

- **Spacing, type and hairlines come first.** Rows are separated by space and a 1 px `--hairline`, groups by a heading
  with room above it. The title is the row's one line in full voice, a touch heavier (500). Everything under it is
  `xs` and `--quiet`. Rows that have ended (merged, closed, done) step back to `--quiet`.
- **Cards only where they earn it:** one thing that stands apart from the list around it (what merges now, a PR's
  summary, a floating surface). Never a card per row.
- **No coloured left edge** on a card, row or callout. A quote or indent rule is a neutral `--hairline`.
- **Colour is for meaning only:** danger for failure, warning for waiting on you, success for done and at work. A
  state is said in words, coloured and weighted, before it is said with a mark.

## Marks

- **Few dots.** A state is a word first. Where a mark helps, use the state glyph (`primitives/StateGlyph`): a 3×3
  dither cell whose shape is the state.
  - working: grain
  - thinking: one lit cell walking the ring
  - waiting on you: a solid block
  - queued: an open ring
  - paused: two bars
  - done: settled to the floor (the bottom row lit)
  - failed: a cross
- One dot is fine where it is the whole message (an unread chat, the hub's connection). Never a dot beside a word
  that already says it.
- A sent message's receipt is a mark beside the bubble, its words in the tooltip: the open ring while the lead hasn't
  taken it, a plain check once it has. Never a sentence under the bubble unless there is something to do.
- **No halo, pulse or glow** on any mark.

## Controls

- **Compact:** segmented controls and tabs are 22–26 px tall, with `xs` text, `--radius-sm` segments in a `--hover`
  track, and the selected one `--raised` with a hairline ring and weight 500.
- **Aligned:** an icon sits beside its word, never above it, and both are centred in the control. A count is bare
  figures in `--faint` with tabular numerals, on the word's baseline at the same size. No pill.

## Motion

- **Snappy:** things arrive fast and stop dead, and nothing floats.
  - `--ease-snap` (`cubic-bezier(0.2, 0, 0, 1)`) for every transition and entrance.
  - `--dur-quick` 140 ms for state changes and hovers.
  - Entrances:
    - a list row: `--dur-row-in` 160 ms, rising `--row-rise` 3 px
    - a chat bubble: `--dur-enter` 200 ms, rising 6 px, a reply's bubbles 50 ms apart
    - your own send: 140 ms
  - Never scale text.
- **Loops step, they don't glide.** Every loop runs on `steps()`, in the language of dithers and terminal renders:
  - grain (working), `--dur-grain` 720 ms: each cell of the glyph flicks on its own clock
  - walk (thinking), `--dur-walk` 960 ms: one cell round the ring
  - scan (words being made, `[data-sweep]` in `base.css`), `--dur-scan` 1.4 s: a narrow band of 2 px dither steps
    across the words, then rests; the train's CI band is the same
  - dots (the lead writing), `--dur-dots` 900 ms: three square cells lit in turn
- **Only what is live moves, and only while it is live:** an agent at work, the lead thinking, a PR in CI, the lead
  writing.
  - Waiting, queued, paused, done and failed are still.
  - An ending wipes its shape in once, cell by cell, and only when it happens while you look (`lib/arrival`): not on
    first showing, and not when a virtual list mounts a row on scroll.
  - A glyph morphs, cell by cell, when its state changes.
- **Only `transform` and `opacity` animate**, so nothing reflows. Closing a menu, popover or dialog is instant.
- **Reduced motion:** no loops, and entrances are a plain fade. Each state keeps a still shape of its own (working is
  a diamond on a dim field, thinking the ring's top row).
- **Cost:** loops pause while the window is hidden (`:root[data-still]`), and loops in a list are out of step
  (`--glyph-phase`). Check a change that adds a loop with `pnpm perf`.
- **Never:** gradient blobs, rainbow or soft shimmer, confetti, sparkles, bouncing or overshooting easings.
