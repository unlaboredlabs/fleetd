-- How many iOS simulators a Mac runs at once (Settings › Workspace › Machines › Screens, `machine_roles_set maxSims`):
-- the agents' Mac, or a Mac that lends its own agents its simulators. NULL: the default (node/mac_tool SIMS_DEFAULT).
ALTER TABLE machine_roles ADD COLUMN max_sims INTEGER;
