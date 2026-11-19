-- Where the team's agents and their Linux screens run (Settings › Hub › Machines, What runs where › Linux machine;
-- hub/sandbox/index.ts `linux`): key 'linux', value 'ours_first' (the team's machines, then the connected providers in
-- order once theirs are full), 'ours_only', or a provider's id (that provider only). No row: 'ours_first', which every
-- hub did before the pick.
CREATE TABLE sandbox_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
