-- Factory metrics, the person's minutes: a touch on work fleetd didn't write (a review of an outside PR, its merge
-- by hand) is `outside`, and the person's own git host logins and emails decide whose reviews are theirs.
ALTER TABLE metric_touches ADD COLUMN outside INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE metric_identities (identity TEXT PRIMARY KEY, src TEXT NOT NULL);
