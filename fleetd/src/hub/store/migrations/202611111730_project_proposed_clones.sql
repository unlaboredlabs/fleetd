-- A clone a person's approval of a lead's `project_propose` started (W614, D448): `proposed` is the new project's
-- title, where a lead's `repo_add` leaves it NULL. A lead whose proposal's clone a hub restart cut off is told so.
ALTER TABLE project_setup_clones ADD COLUMN proposed TEXT;
