-- Cloud machines' placement (W407, D306): a task goes to a cloud machine only when its project's own machine is at its
-- agent limit. `slot_claims.on_machine` is the cloud machine a claim counts against (null: its project's own machine).
-- `pool_settings.writers` lets writers run on cloud machines too; off until the admin turns it on (reviews and readers
-- go first).
ALTER TABLE slot_claims ADD COLUMN on_machine TEXT;
ALTER TABLE pool_settings ADD COLUMN writers INTEGER NOT NULL DEFAULT 0;
