-- The hub admin's setup (docs/design/setup.md): the steps put off for later. Everything else about a step is read
-- from the doctor's checks.
CREATE TABLE setup_skips (step TEXT PRIMARY KEY, at_ms INTEGER NOT NULL);
