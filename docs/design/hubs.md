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
cache in Electron's userData: the first keeps `hub-cache.json`, and each further hub gets `hub-cache-<id>.json`.

**Pairing.** The first hub pairs through onboarding as it does today. More hubs, renames, colours and removal are in
**Settings › Hubs**. Add a hub asks for its address and a pairing code (or a key), a label and an optional colour.
Remove forgets that hub's key and cache and leaves the other hubs alone. The onboarding screen takes the whole window
only when no hub is paired.

**Main.** `main/hub/hubs.ts` holds one `HubService` per hub. That is today's service, unchanged inside: its own
connection, retries, chat, focus and watched session. Every hub IPC channel takes the hub id first. Frames go to the
page as `{hub, frame}`. Presence goes to each hub, and only the hub on screen hears which project it is.

**Renderer.** Each hub has its own data layer: store, query cache and offline cache (`renderer/src/data/queries.ts`,
unchanged inside). `HubScope` provides one hub's layer to whatever is inside it, so every screen talks to the right hub and none
of them needs to know there are others. A route names its hub as `?hub=<id>`, which is left out for the first hub, so
a single-hub app's links don't change. Navigating without a hub stays on the hub of the screen you're on. The app's
own memory per project (chats seen, the last project opened) is keyed by hub plus project.

**One sidebar.** The Navis come first, across every hub, each with its hub label. A Navi is a project with
`kind: "assistant"` (D184), and #651's Navi section sits above every hub's groups. A Navi's menu (rename, archive,
settings) acts on its own hub, and a collapsed group never hides its Navis. After them, each hub's projects sit under
its label, a quiet heading with a hairline and the colour as a small mark. Each group collapses, and the app
remembers which ones you collapsed. ⌘1–9 count the rows on show: the Navis, then each open group's projects. With one
hub there is no label and no group: the sidebar looks as it does with #651 alone.

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

**Fixtures.** The app PR adds three optional fields to a fixture file: `label` and `color` for the file's own hub, and
`hubs: [{label, color?, fixture}]` for more hubs beside it. `pnpm fixtures` builds `sidebar-hubs` (two labelled hubs) and `sidebar-hubs-offline` (one of them
offline) for `pnpm web:preview` and QA.

## Hub links

A link lets a Navi on hub A reach projects on hub B. Another workstream builds it. This section is the contract the
app relies on.

**What a link is.** The person mints a key on hub B. That key acts as them, at the lesser of their role on B and the grants of the
device that made it, never above operate, optionally limited to projects they choose. They paste it into hub A, and A keeps it sealed, like any secret. Through it, A's Navi opens
orders in B's projects (`project_message`), reads their status (`factory_status`) and hears when work lands. B records
every request as that person and sees nothing of the Navi or its chat. D186, under which admins can read Navis, applies
only to Navis on the admin's own hub.

**Revoking.** Either side can revoke a link. Revoking on B makes the key fail. Revoking on A deletes it and, when B is
reachable, revokes it there too. Either way, the Navi's next call is refused with a plain sentence saying so.

**Reachability.** Hub A must reach hub B over the tailnet or HTTPS. When it can't, the link shows "can't reach
\<label\>", with the reason (refused, no route, TLS) and the fix. The Navi's calls fail with the same sentence, never
silently.

**Where it's managed in the app.** Not built yet: the app has no screen for links. Until it does, the hub tools are
the only way to make, list and remove them (`hub_link_mint`, `hub_link_add`, `hub_links_get`, `hub_link_revoke`,
`hub_link_remove`). The screen, when it comes, reads both lists from
`hub_links_get` on each hub. Links stored on a hub show in the Navi's own settings ("Linked hubs"). Keys minted on a
hub show in the person's own settings for their own keys, and on Administration for an admin. They never appear as
admin controls in Settings (D186):

- **Reaches** (links stored on this hub): the other hub's label and address, the projects it is limited to (or all),
  its state (working, can't reach, revoked), when it was last used, and Revoke.
- **Reached from** (keys minted here for other hubs): the label it was minted under, its projects, when it was last
  used, and Revoke.
- **New link**, on the hub to be reached: pick projects (optional), then copy the one-time link text and paste it on
  the other hub.

**What the app shows elsewhere.** Nothing of its own yet, and nothing it needs to: the hubs write it. In a Navi's chat,
its wake lines name the project with the other hub's label ("N4 to Storefront on acme: …"). In the target project's
chat on B, the message shows as "\<person\> via \<A's label\> Navi",
because B sees only the requests. Like a Navi's message on its own hub, it is input to B's lead, never an answer or an
approval. Nothing else in the app changes: B's projects show under B's label only when the app
is paired with B as well.

### The link contract, as built

The code is `crates/fleetd/src/hub/hub_links/` (store, `serve.rs` on B, `client.rs` on A, `tools.rs`); the types are
`crates/fleetd-contracts/src/hub_links.rs`. Hub B is the hub whose projects a link reaches, hub A the hub with the Navi.

**Minting and keeping.** On B, a person's device calls `hub_link_mint {label, projects?}`: `label` is what they call
A ("home"), `projects` limits the link (each one they can operate), and the answer carries the key, `flk_…`, once. B
keeps its SHA-256, the minting device's key id, its grants and its person. The link acts as that person at the lesser
of their hub role, read at each request, and those grants, never above operate (a link has no admin call): a read-only
device can't mint one (`forbidden`), and a link never holds more than the device that made it. It stops when its
person is removed from the hub; revoking the device doesn't stop it. A link minted before people acts at its device's
grants and dies with it. On A, the Navi's owner or an admin calls `hub_link_add {navi, label, url, sealed}`: the app
seals the key with `crypto_box_seal` to A's own box key (`boxPubKey` from `hub_links_get`, kept in A's home), A opens
it only to call B, checks it with `GET /link/v1/hello` and keeps it sealed per Navi. No tool returns it again and it
never enters a chat or transcript. `hub_links_get {navi?}` reads both sides: the Navi's links on A with their state,
and the links minted on B (the caller's own, or every one for an admin).

**1. What a link key may do on B.** A link key works only on `/link/v1`, and only these five calls:

| Call | What it does |
| --- | --- |
| `GET hello` | the link's label, the projects it reaches, the feed's start cursor |
| `POST ask {project, text}` | `project_message` into a project's chat; needs operate on the project's machine |
| `GET status?project=` | `factory_status` over the projects it reaches, with the link's own asks and their orders |
| `GET feed?after=&wait=` | news about the link's own asks: an order opened, done, stopped, a PR merged or failed |
| `POST revoke` | the link revokes itself (A removing it) |

Each call checks the key, the link not revoked, not idle for 90 days, and its person still on the hub; a key dead for any
of these is refused with 401 and `dead: true` (`LinkRefusal`), and only that body makes A mark the link revoked. A
store failure is a 500, and any other refusal or a 401 without `dead` leaves the link as it was, so a passing error
never kills it. A calls only the URL it was given: no redirects, and no answer over 1 MB. Then come the link's rights (its
person's role and its device's grants, as above): read to see a project, operate to ask in it, and the link's project limits. A project outside them is refused
(`forbidden`, "X is not one of this link's projects"); one the person can't read doesn't exist for the link. Nothing
else takes a link key: `/mcp` and `/app` refuse it (it is no `fld_` key), so there is no tool, no chat read, no
approval, no secret and no admin through a link.

**2. A message through a link is never the person's answer.** It goes into B's project chat as an agent message
(`ChatAuthor::Agent`) written by "\<person\> via \<A's label\> Navi", for example "Alex via home Navi". B's lead reads it
through `chat.agent`, as input. It answers no question (needs-you stays as it was), approves no gated command, enters no
secret and approves no merge: those take a person's own device on B. B stores the ask in `navi_asks` with `via_link`
and sees nothing of the Navi: no title, no chat, no transcript.

**3. How A hears about landings.** B never calls A; only A needs to reach B. A runs one follower per link
(`client::follow`) that long-polls `GET feed`: B holds the request up to 25 seconds and answers as soon as one of the
link's asks has news, from a cursor A keeps on the link. A maps B's handle to its own (`navi_asks.to_hub`, `remote`)
and wakes the Navi's lead with one line, "- N4 to Storefront on acme: PR #42 (acme/shop) of order W3 merged". When B
doesn't answer, the follower retries every 30 seconds and the link reads "unreachable" with the reason; nothing is lost,
as the cursor waits. The follower stops when the link is removed on A, even mid-read (what that read brought wakes no
one), and when its Navi is archived.

**4. Revoking while the other side is unreachable.**

- A removes the link while B is down: A deletes the sealed key at once, so the Navi's next call is refused ("no linked
  hub called acme") and the follower stops. A asks B to revoke it too; when B doesn't answer, `hub_link_remove` says
  so (`revokedThere: false`). B still lists the link until its person or an admin revokes it, but its key exists
  nowhere any more. A link unused for 90 days expires: B refuses its next use and marks it revoked. A followed link is
  used every 25 seconds, so only abandoned links expire.
- B revokes the link while A can't reach B: B refuses the key at once, but A hears of it only on its next call that
  gets through, since B never calls A. Until then A's calls fail as "can't reach"; the first one that reaches B gets
  "revoked", marks the link revoked on A, wakes the Navi once ("The link to acme no longer works…") and stops its
  follower. Either way, nothing goes through a revoked link.

**Reachability.** A link URL is `https://`, or `http://` only to loopback or over a tailnet (100.64.0.0/10,
fd7a:115c:a1e0::/48, `*.ts.net`); plain HTTP elsewhere is refused before anything is sent, since the key would cross
the network in the clear. An unreachable B gives `failed` with "Can't reach acme at \<url\>: \<reason\>." and the fix
"A hub link needs acme's hub reachable from this hub, over a tailnet or HTTPS."

**The Navi's calls.** `project_message` and `factory_status` take `hub`, a linked hub's label. Without it,
`factory_status` lists the Navi's linked hubs with their state (`hubs`). Handles stay this hub's `N<n>`.
