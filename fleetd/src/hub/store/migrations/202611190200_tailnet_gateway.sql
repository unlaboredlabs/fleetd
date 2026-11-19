-- The team's Tailscale gateway (hub/tailnet): its tailscaled's login state, sealed under the vault's root key as a vault
-- item is. One row while Tailscale is connected; none otherwise.
CREATE TABLE tailnet_gateway (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  sealed BLOB NOT NULL
);
