-- W214: each person's own order of the projects and Navis in their sidebar, as sidebar_order_get shows it (a JSON
-- array of project refs). One row per person; none until they move one.
CREATE TABLE sidebar_orders (person_id TEXT PRIMARY KEY, refs TEXT NOT NULL);
