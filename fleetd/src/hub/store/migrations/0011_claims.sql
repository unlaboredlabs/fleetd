-- M6 claims. A row is numbered when the claim starts; `outcome` and `data` (the Claim) are set when its checks end,
-- so a claim superseded or cut off by a restart stays NULL and is never listed.
CREATE TABLE claims (
    n INTEGER PRIMARY KEY AUTOINCREMENT, workstream_id TEXT NOT NULL, machine_id TEXT NOT NULL, project_id TEXT NOT NULL,
    outcome TEXT, data TEXT
  );
  CREATE INDEX claims_by_workstream ON claims (workstream_id, n DESC);
