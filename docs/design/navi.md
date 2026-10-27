# Navi

## The factory bridge (W97)

Navi works with the other projects on its hub through three things: a message to a project's lead, one read of the
whole factory, and a wake when what it asked for changes. The code is `crates/fleetd/src/hub/navi/bridge.rs`; the
contracts are `crates/fleetd-contracts/src/navi.rs`.

**Who may use it.** Only a Navi's lead: a project the hub keeps in `assistants`, not archived. Any other lead is
refused (`bridge::may_use`), and a task never makes the calls (`hub/tasks/policy.rs`). A Navi can't message its own project or
one the hub doesn't have. One person owns every project on a hub today, so there is no owner check yet: owners arrive
with company Navi (one Navi per person on a shared hub), and the check goes in the same function.

**`project_message {project, text}`.** `project` is a title or project id. The text goes into that project's chat as
the agent "Navi <title>" (`chat::flow::send_as_agent`), never as the person, so its lead reads it through `chat.agent`:
input, never the person's answer or approval. Navi can't approve a gated command, a secret or a merge anywhere; those
stay with the person, in that project's chat. Each message is an ask with a handle, `N<n>`, which the call returns and
the message ends with:

> (Ask N3. If you open an order for it, pass asked: "N3" to brief, so Navi hears when it lands.)

The person sees all of it: Navi's message in the target chat under Navi's name, and Navi's own turn in its chat.

**`factory_status {project?}`.** One read-only call over every other project, or the one named. Each project comes
with its status row's state (working, waiting on the person, blocked, idle), why it's blocked, a red main
(`warning`), running agents, its last merge and merges over 7 days. It also lists open orders with their headlines,
checklist items not done, and this Navi's last asks to it with the orders opened for each.

**Being told.** The lead that opens an order for an ask passes `asked: "N3"` to `brief`. Its `workstream.created`
event carries the handle, and the order is linked only when it is in the project that was asked. From then on
`bridge::run` follows the event log, with its cursor in `time_cursors` as `navi.bridge`, and wakes the asking Navi's
lead with one line (`LineKind::Factory`) when:

- its lead opens the order: `- N3 to Storefront: its lead opened order W12 "Gift cards"`;
- a PR of the order merges, fails CI, is refused or is given up by the train (`change.state`);
- the order is closed as done, or stopped.

Orders a lead opens on its own wake no Navi. A reply to a question doesn't wake Navi yet: the person sees it in that
project's chat.

**Storage.** `navi_asks` holds one row per message (from, to, text, when); `navi_ask_orders` maps each order opened
for an ask to it. An ask may become several orders.
