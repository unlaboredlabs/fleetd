# The app's design rules

The desktop app follows these rules. The values live in `tokens.css`; this page says how to use them. A change that
breaks a rule changes this page in the same PR and says why.

## Layout and separation

- **Spacing and type come first.** Rows are separated by space, never a line between them; groups by a quiet label
  with room above it. The title is the row's one line in full voice. Everything under it is smaller and `--quiet`.
  Rows that have ended (merged, closed, done) step back to `--quiet`. A line between every row reads as clutter.
- **Settings are soft groups** (`screens/settings/parts.tsx`; every Settings page, and the Vault's, is built from these
  and has no row, line or card style of its own):
  - a section is a quiet 12 px label (an optional quiet line under it) over **one soft group**: a `--group` fill with
    `--radius-group` corners and no lines inside it (`SettingsSection`);
  - a row is a title in regular weight, an optional quiet line, and **one control at its right end** (`SettingsRow`);
    a row that holds a list or a form puts it under its title, full width;
  - a switch's own words are its row (`SwitchRow`), so nothing is said twice; three short choices are a segmented control;
  - a list row is a glyph, the name with a quiet word beside it, quiet lines under it, and its controls; its state is
    the word itself, coloured, never a dot (`SettingsListRow`); a row that opens a page trails a chevron;
  - **add is a plus** (`AddButton`), at the end of its row or section label; **danger is one red pill**
    (`DangerButton`, `--danger-fill`), and what it does is confirmed in a dialog;
  - **Save shows once there is something to save**, and a control that can't be used says why in its row's line;
  - buttons and fields on a group are `--raised`; the column is 760 px, left-aligned under the page title.
- **Cards only where they earn it:** one thing that stands apart from the list around it (what merges now, a PR's
  summary, a floating surface). Never a card per row.
- **No coloured left edge** on a card, row or callout. A quote or indent rule is a neutral `--hairline`.
  `leftEdges.test.ts` fails on a coloured `border-left`, `border-inline-start` or left-stripe `box-shadow`.
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
- One dot is fine where it is the whole message (an unread chat, or one that waits on you in the warning's colour, why
  in its tooltip: the sidebar's rows). Never a dot beside a word that already says it.
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
    - a chat bubble glides in (`screens/chat/glide.ts`): the conversation moves as one sheet, the new bubble rising
      from behind the composer's island with the rows above it on a critically damped spring (a reply: stiffness 500,
      damping 44.7, mass 1; your send: 650, 51; the last message growing, as a streamed reply's text takes its dots'
      place: 700, 53). One additive transform on the rows, so a burst sums. The bubble fades in over its first
      `--dur-enter` 100 ms (`--ease-out`), a reply's bubbles 50 ms apart; it never moves or scales on its own. A
      streamed reply enters once, as the lead starts writing. The list runs on behind the glass island to the
      window's edge. Scrolled up, nothing glides.
  - Never scale text.
- **Loops step on one beat, never on CSS animations.** While something live is on screen, `ui/lib/beat` advances
  every 120 ms (24 beats) and hands each loop the beat to write onto its own elements, so every loop steps together
  and the page draws only on a beat. A running CSS animation would draw a frame every vsync, which keeps a key press
  waiting for the next one.
  - A beat restyles only what changes: a glyph sets `data-lit` on the cells whose light changes, a scan or band takes
    the beat as `data-step`. Nothing on `:root` changes per beat (it carries `data-beat` while the beat runs), so a
    beat's frame with 20 agents at work is about 1 ms of main thread, not 5.
  - Grain (working): each cell of the glyph flicks on a beat or two at a time, in one of four phases.
  - Walk (thinking): one cell steps round the ring, a beat a step (960 ms round).
  - Scan (words being made, `[data-sweep]` in `base.css`): a narrow band of 2 px dither steps across the words, then
    rests. The train's CI band is the same.
  - Dots (the lead writing): three square cells lit in turn, two beats each.
  - The beat **keeps its tempo while you type, click or scroll.** It steps on the clock; a step a long task held late
    lands on the beat the clock is on, so the loops never slow down. A key, click or wheel within 30 ms of a step,
    before or after, takes the step onto its own frame: while you type, the beat draws no frame of its own for a key to wait out.
  - A new loop is CSS keyed on `data-step` plus `useBeatRef(live)` on its element, or `useBeat(live, step)` writing
    only what changes; never `animation: … infinite`.
- **The bot is the one exception to the beat** (D377, `primitives/Bot`, `lib/botLife`): one character for every
  project without a picture, whose motion says its state (idle, thinking, working, needs you, done, an error). Its
  channels are springs at the display's rate, so a state change blends from wherever it is. It draws frames only while
  it's on screen, the window is visible and it moves: idle bots in a list take turns for a blink or a glance, one every
  1.6 to 3.6 s, and only a bot in a live state keeps moving. While you type every bot holds still (its clock stops) until
  1.2 s after the last key, so a key press never waits on its frame. With reduced motion each state settles into its
  still pose. It has no circle: the body alone, in one calm slate, is the picture, cropped to fill its box, and its hops
  and slumps reach past it, so nothing that holds it clips it (pictures and initials stay round). Below 44 px as drawn
  (a 36 px box draws it at 45) it uses larger eyes, 0.8 of the body motion and no glow.
  It's drawn on a canvas, never as SVG rewritten each frame: every new transform or path left style garbage that
  only a major GC frees, 60 MB of the renderer for three moving bots.
- **Only what is live moves, and only while it is live:** an agent at work, the lead thinking, a PR in CI, the lead
  writing.
  - Waiting, queued, paused, done and failed are still.
  - An ending wipes its shape in once, cell by cell, and only when it happens while you look (`lib/arrival`): not on
    first showing, and not when a virtual list mounts a row on scroll.
  - A glyph morphs, cell by cell, when its state changes.
- **Only `transform` and `opacity` change**, so nothing reflows. Closing a menu, popover or dialog is instant. A row
  leaving a list fades in place for 140 ms (`lib/leaving`), then the gap closes.
- **The sidebar and the panel slide** from the window's edge as their toggle opens or closes them, already at their
  own width: in over `--dur-base` (180 ms), out over `--dur-fast` (120 ms), both `--ease-out`, as a transition, so a
  toggle mid-way turns back from where it is. The frame lays out once, at the toggle: the chat takes its new width in
  that frame, and a side going out is drawn over its edge until it has gone (`AppFrame`). Another screen bringing or
  taking one swaps it at once.
- **A row you drag** (`lib/reorder`) lifts after 4 px: raised a step with a small soft shadow, never scaled, it rides
  the pointer. The rows it passes slide aside over `--dur-base` to open its gap; let go, the list takes the order in
  that frame and the row glides from where it was let go into its slot over the same, `--ease-out`, its shadow fading as
  it lands (FLIP: every row is put back where it was on screen and glides to its new place, so none is ever anywhere
  else; another desktop's move mid-glide turns them toward their newer places). Near a scrolling list's top or bottom
  (48 px) the list scrolls, easing in (squared) to 14 px a frame at the edge, and the lifted row stays under the
  pointer. As on iOS and macOS it waits for the pointer to head 6 px for that edge, or rest near it 500 ms. Esc glides
  it back. ⌥↑ / ⌥↓ move a focused row, gliding the same way. With reduced motion nothing glides: the rows step aside
  and the drop lands at once.
- **The sidebar's one kinetic moment:** a chat with new activity glides to its place on `--ease-spring` over
  `--dur-spring` (360 ms), a critically damped spring sampled into `linear()`: from rest, settling without overshoot.
  A row climbing passes over the rows it overtakes on the sidebar's own tone (`data-gliding="up"`), so no two lines of
  words cross. Nothing moves while the pointer is over the list; what changed takes its place once it leaves. A
  pinned row dragged or moved with ⌥↑ / ⌥↓ lands on the same spring.
- **Reduced motion:** no beat, so no loops, and entrances are a plain fade (a chat bubble 200 ms on `--ease-snap`,
  your send 140 ms, the list taking its new place at once). Each state keeps a still shape of its own
  (working is a diamond on a dim field, thinking the ring's top row).
- **Cost:** no beat while the window is hidden or with reduced motion. Check a change that adds a loop with `pnpm perf`
  against main.
- **Never:** gradient blobs, rainbow or soft shimmer, confetti, sparkles, bouncing or overshooting easings.
