-- The node key of each machine the hub removed (`machine remove`, the app's Remove): a node that comes back with it is
-- told it was removed, and stops as enrolled until it joins again. Any other node the hub holds no key for (one from
-- before an import) is told it isn't enrolled, as before.
CREATE TABLE removed_node_keys (
  machine_id TEXT PRIMARY KEY,
  pub_key TEXT NOT NULL,
  removed_ms INTEGER NOT NULL
);
