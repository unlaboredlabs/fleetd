-- Issues are orders (hub/issues): a GitHub issue labelled `fleetd` in a bot's repo opens one order in that bot.
-- `issue_orders` keeps one row per issue (`repo` is `owner/name`, lowercased): the order it opened, or why it was left,
-- and in `data` the labelling it came from and the comments and wakes already sent, so a restart, a second poll or a
-- webhook delivered twice opens and says nothing twice. `issue_watch` is when the hub began watching each repo: only
-- a labelling after that opens an order, so turning the switch on doesn't turn a repo's old labels into orders.
CREATE TABLE issue_orders (
  repo TEXT NOT NULL, number INTEGER NOT NULL, machine_id TEXT NOT NULL, project_id TEXT NOT NULL,
  workstream_id TEXT, data TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);
CREATE INDEX issue_orders_by_workstream ON issue_orders (workstream_id);
CREATE TABLE issue_watch (repo TEXT PRIMARY KEY, since_ms INTEGER NOT NULL);
-- A bot's switch (`project_settings_set` issueOrders): NULL is on, the default for a bot with a repo; 0 is off.
ALTER TABLE project_settings ADD COLUMN issue_orders INTEGER;
