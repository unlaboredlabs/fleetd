-- The merge train's check lists live only in each repo's .fleetd/train.json now: the hub's own copy goes.
ALTER TABLE project_settings DROP COLUMN train;
