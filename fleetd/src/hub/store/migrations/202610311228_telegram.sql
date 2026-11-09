-- W237: each Navi's Telegram bridge. `data` is the bridge as telegram_get shows it (the token's fingerprint, the bot,
-- the paired account, the node's last status), never the token; `taken` is the node journal's last seq handled and
-- `sent` the Navi chat's last seq sent to Telegram.
CREATE TABLE telegram_bridges (
  machine_id TEXT NOT NULL, project_id TEXT NOT NULL, data TEXT NOT NULL,
  taken INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (machine_id, project_id)
);
-- Each approval card sent to Telegram, by request: its message, edited once the request is answered anywhere.
CREATE TABLE telegram_cards (
  request_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, project_id TEXT NOT NULL, message_id INTEGER NOT NULL,
  shown TEXT NOT NULL
);
