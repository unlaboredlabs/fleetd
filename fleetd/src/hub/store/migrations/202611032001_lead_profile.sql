-- The lead's own profile (W394): at most one profile is marked as the one leads start on; none marked, they start on
-- the default, as before. Deleting the marked profile deletes the mark with it, so leads fall back to the default.
-- Each lead keeps the profile its session started on, for its lane; none (one started before): the default.
ALTER TABLE profiles ADD COLUMN is_lead INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX profiles_one_lead ON profiles (is_lead) WHERE is_lead = 1;
ALTER TABLE leads ADD COLUMN profile TEXT;
