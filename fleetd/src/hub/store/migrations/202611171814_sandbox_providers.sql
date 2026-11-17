-- The team's own hosted sandbox accounts (hub/sandbox): one row per connected provider (boat, e2b, daytona). `sealed`
-- is its API key sealed under the vault's root key as a vault item is (never shown, logged or given to an agent);
-- `domain` E2B's own API domain for a self-hosted E2B, NULL for e2b.app; `max_agents` how many of the team's agents
-- may run there at once; `check_json` its last check.
CREATE TABLE sandbox_providers (
  provider TEXT PRIMARY KEY CHECK (provider IN ('boat', 'e2b', 'daytona')),
  sealed BLOB NOT NULL,
  domain TEXT,
  max_agents INTEGER NOT NULL CHECK (max_agents >= 0),
  check_json TEXT
);
