-- Cloud machines on boat.dev (W407, hub/pool): the hub's ledger of the fixed pool of boat machines it owns. Every row
-- is written before the boat call it stands for, so a crash leaves nothing running that the hub doesn't know of.
--
-- pool_settings: the one row of what the admin set, the hub's boat key sealed to the hub's box key, and why starts
-- are held back. `hub_id` labels every machine this hub makes (fleetd.hub=<hub_id>); machines with another hub's id
-- are never touched. Off until the admin turns it on.
CREATE TABLE pool_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    hub_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    pool_size INTEGER NOT NULL DEFAULT 3,
    machine_type TEXT NOT NULL DEFAULT 'large',
    day_budget REAL NOT NULL DEFAULT 3.0,
    -- Dollars; null: the plan's included dollars, as /limits last said (plan_dollars).
    month_budget REAL,
    -- The projects whose work may run on cloud machines: a JSON list of {machineId, projectId}.
    projects TEXT NOT NULL DEFAULT '[]',
    -- The boat environment machines are created in, when the admin made one for fleetd; null: none.
    environment TEXT,
    sealed_key BLOB,
    -- 'billing' or 'key': boat refused starts until a sweep's /limits says it can start again, or the admin resumes.
    paused_kind TEXT,
    paused_reason TEXT,
    -- No start before this (ms), and the one line that says why: boat's backoff.
    hold_until INTEGER,
    hold_reason TEXT,
    -- Consecutive retries the current backoff is at.
    backoff_step INTEGER NOT NULL DEFAULT 0,
    -- 1 while boat says its machines-at-once limit is full: no start until one of ours stops.
    full INTEGER NOT NULL DEFAULT 0,
    -- What /limits last said: the plan's included starts per minute, hour and day, and its dollars a month.
    starts_minute INTEGER,
    starts_hour INTEGER,
    starts_day INTEGER,
    plan_dollars REAL,
    -- Set once the warning that boat runs machines this hub doesn't know was given, cleared when the counts agree.
    strangers_warned INTEGER NOT NULL DEFAULT 0
);
INSERT INTO pool_settings (id, hub_id) VALUES (1, lower(hex(randomblob(8))));

-- pool_machines: one row per slot (its machine id, boat-1…), the hub's truth about each VM. `idem_key` is the current
-- create attempt's Idempotency-Key and its fleetd.attempt label; `create_body` that attempt's body sealed to the hub's
-- box key (it holds a one-time enroll token), kept only until boat answers and `body_until`, the token's end.
CREATE TABLE pool_machines (
    slot TEXT PRIMARY KEY,
    sandbox_id TEXT,
    state TEXT NOT NULL,
    idem_key TEXT,
    create_body BLOB,
    body_until INTEGER,
    created_at INTEGER NOT NULL,
    awake_since INTEGER,
    -- When the last create or resume was sent: a hello counts only after it.
    wake_at INTEGER,
    -- 'need', or 'keepalive' for a wake that only keeps the disk from expiring.
    wake_why TEXT,
    asleep_since INTEGER,
    lease_until INTEGER,
    renewed_at INTEGER,
    idle_since INTEGER,
    wake_failures INTEGER NOT NULL DEFAULT 0,
    note TEXT
);
CREATE UNIQUE INDEX pool_machines_sandbox ON pool_machines (sandbox_id) WHERE sandbox_id IS NOT NULL;

-- pool_starts: each start (create or resume) counted before its call, for the rolling-window start budget; refused
-- = 1 when boat clearly didn't count it.
CREATE TABLE pool_starts (
    at INTEGER NOT NULL,
    slot TEXT NOT NULL,
    what TEXT NOT NULL,
    refused INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX pool_starts_at ON pool_starts (at);

-- pool_spend: fleetd's own meter, one interval per wake, open (`until_ms` null) from the create or resume call until
-- the hub sees the machine stopped, priced at its type's dollars an hour.
CREATE TABLE pool_spend (
    id INTEGER PRIMARY KEY,
    slot TEXT NOT NULL,
    sandbox_id TEXT,
    from_ms INTEGER NOT NULL,
    until_ms INTEGER,
    per_hour REAL NOT NULL
);
CREATE INDEX pool_spend_open ON pool_spend (slot) WHERE until_ms IS NULL;

-- pool_boat_cost: boat's own figure for a sandbox since the start of a day or a month, read each sweep: where it is
-- higher than the meter, the meter takes it.
CREATE TABLE pool_boat_cost (
    sandbox_id TEXT NOT NULL,
    since_ms INTEGER NOT NULL,
    dollars REAL NOT NULL,
    PRIMARY KEY (sandbox_id, since_ms)
) WITHOUT ROWID;
