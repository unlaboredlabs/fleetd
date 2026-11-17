-- Where a task's slot runs (hub/slots/board.ts): NULL or 'local' for its machine's own slots, else the hosted provider
-- the board placed it with ('e2b', 'boat', 'daytona'), counted against that provider's team-wide limit. `hostable`: the
-- task runs on a Claude account, not its machine's own login, so it may go to a hosted sandbox.
ALTER TABLE slot_claims ADD COLUMN place TEXT;
ALTER TABLE slot_claims ADD COLUMN hostable INTEGER NOT NULL DEFAULT 0;
