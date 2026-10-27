# Several hubs and hub links

W104, decided in D194. The app connects to several hubs at once, each under a label the person picks. A Navi on one
hub reaches projects on another through a hub link. Paths are under `app/desktop/src/` unless shown otherwise.

## Why

People keep personal work and team or company work apart: separate hubs, admins, machines and accounts. One app
should still show all of it, and one Navi should still reach work everywhere the person belongs.

## The app with several hubs

**One hub per pairing.** Each paired hub is an entry `{id, label, color?}`. The person types the label in free text,
such as "Personal", "Acme" or "Side project". It is never a fixed personal/work choice. It is 1 to 40 characters and
defaults to the hub's host name. The colour is optional, one of a few named swatches that read in light and dark. It
only tells the groups apart and carries no state.

**Storage.** The list lives in `<fleetd dir>/desktop-hubs.json` (0600), in sidebar order, with no keys in it. Each
hub's URL and key go in the existing secure store (`main/hub/credentials.ts`: safeStorage, or a 0600 file and the
reason why). The first hub keeps today's files (`desktop-hub.bin` or `.json`, id `hub`), so an upgraded app is
already that first hub. Each further hub gets `desktop-hub-<id>.bin` or `.json`. Each hub also has its own offline
cache, `hub-cache-<id>.json`.

**Pairing.** The first hub pairs through onboarding as it does today. More hubs, renames, colours and removal are in
**Settings › Hubs**. Add a hub asks for its address and a pairing code (or a key), a label and an optional colour.
Remove forgets that hub's key and cache and leaves the other hubs alone. The onboarding screen takes the whole window
only when no hub is paired.

**Main.** `main/hub/hubs.ts` holds one `HubService` per hub. That is today's service, unchanged inside: its own
connection, retries, chat, focus and watched session. Every hub IPC channel takes the hub id first. Frames go to the
page as `{hub, frame}`. Presence goes to each hub, and only the hub on screen hears which project it is.

**Renderer.** Each hub has its own data layer: store, query cache and offline cache (`src/data/queries.ts`, unchanged
inside). `HubScope` provides one hub's layer to whatever is inside it, so every screen talks to the right hub and none
of them needs to know there are others. A route names its hub as `?hub=<id>`, which is left out for the first hub, so
a single-hub app's links don't change. Navigating without a hub stays on the hub of the screen you're on. The app's
own memory per project (chats seen, the last project opened) is keyed by hub plus project.

**One sidebar.** The Navis come first, across every hub, each with its hub label. A Navi is a project with
`kind: "assistant"` (D184), and the sidebar gets its own section for Navis in #651. After them, each hub's projects
sit under its label, a quiet heading with a hairline and the colour as a small mark. Each group collapses, and the
app remembers which ones you collapsed. With one hub there is no label and no group: the sidebar looks as it does
today.

**Merged attention.** Every hub counts, and each item says its hub when two or more are paired:

- The sidebar's marks (reply, approve, secret, blocked) sit on each row, in its hub's group.
- The Dock badge is the sum over every hub.
- Notifications come from every hub's events and policy. The title starts with the hub label, and clicking one
  opens that hub's project.
- Status has one section per hub, under its label.
- Commands (Ctrl+K) lists every hub's projects, each with its hub label beside the machine.

**Connection state is per hub.** The sidebar's footer has one status row per hub, each with its own popover (Retry
now, Hub settings, Disconnect). A hub offline greys only its own group, marked "as of 09:02" as today. The other hubs
keep working. The offline banner shows only for the hub of the screen you're on.

**Updates.** The updates sheet belongs to one hub. Its pill sits on that hub's status row, and Update updates that
hub, its machines and this app.

**Fixtures.** A fixture file may list more hubs (`hubs: [{label, color?, fixture}]`), and the first hub takes the
file's own `label`. `pnpm fixtures` builds `sidebar-hubs` (two labelled hubs) and `sidebar-hubs-offline` (one of them
offline) for `pnpm web:preview` and QA.

## Hub links

A link lets a Navi on hub A reach projects on hub B. Another workstream builds it. This section is the contract the
app relies on.

**What a link is.** The person mints a key on hub B. That key acts as them, at their role on B, optionally limited to
projects they choose. They paste it into hub A, and A keeps it sealed, like any secret. Through it, A's Navi opens
orders in B's projects (`project_message`), reads their status (`factory_status`) and hears when work lands. B records
every request as that person and sees nothing of the Navi or its chat. D186, under which admins can read Navis, applies
only to Navis on the admin's own hub.

**Revoking.** Either side can revoke a link. Revoking on B makes the key fail. Revoking on A deletes it and, when B is
reachable, revokes it there too. Either way, the Navi's next call is refused with a plain sentence saying so.

**Reachability.** Hub A must reach hub B over the tailnet or HTTPS. When it can't, the link shows "can't reach
\<label\>", with the reason (refused, no route, TLS) and the fix. The Navi's calls fail with the same sentence, never
silently.

**Where it's managed in the app: Settings › Hubs, per hub.** The app reads both lists from each hub:

- **Reaches** (links stored on this hub): the other hub's label and address, the projects it is limited to (or all),
  its state (working, can't reach, revoked), when it was last used, and Revoke.
- **Reached from** (keys minted here for other hubs): the label it was minted under, its projects, when it was last
  used, and Revoke.
- **New link**, on the hub to be reached: pick projects (optional), then copy the one-time link text and paste it on
  the other hub.

**What the app shows elsewhere.** In a Navi's chat, a message it sent through a link names the project with its hub
label ("to Shop on Acme"). In the target project's chat on B, the message shows as the person, sent "through a link",
because B sees only the requests. Like a Navi's message on its own hub, it is input to B's lead, never an answer or an
approval. Nothing else in the app changes: B's projects show under B's label only when the app
is paired with B as well.
