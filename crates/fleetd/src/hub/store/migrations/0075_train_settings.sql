-- How the merge train treats a project's repo's checks (`TrainSettings` as JSON; the defaults without a row or with
-- NULL).
ALTER TABLE project_settings ADD COLUMN train TEXT;
