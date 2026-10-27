-- Webhook subscriptions. `secret` is sealed with the key in <home>/webhook.key; `last_delivered_seq` is the
-- delivery cursor; `failing_reported` marks that this failing spell already emitted webhook.failing.
CREATE TABLE subscriptions (
    subscription_id TEXT PRIMARY KEY, created_by TEXT NOT NULL, client_request_id TEXT NOT NULL, url TEXT NOT NULL,
    types TEXT NOT NULL, machines TEXT NOT NULL, secret TEXT NOT NULL, state TEXT NOT NULL, created_ms INTEGER NOT NULL,
    last_delivered_seq INTEGER NOT NULL, failing_since_ms INTEGER, failing_reported INTEGER NOT NULL DEFAULT 0,
    UNIQUE (created_by, client_request_id)
  );
