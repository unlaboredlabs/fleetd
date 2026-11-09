-- Restart hub (W578): each lead keeps what its session was launched with (`profile_launched`: the profile's model,
-- effort and fast mode, as JSON; none for one started before), so a profile edited since reads as changed. A restart
-- from Settings marks the leads whose profile changed (`switch_due`); each starts again on its current profile once
-- its machine is back and its turn has ended.
ALTER TABLE leads ADD COLUMN profile_launched TEXT;
ALTER TABLE leads ADD COLUMN switch_due INTEGER NOT NULL DEFAULT 0;
