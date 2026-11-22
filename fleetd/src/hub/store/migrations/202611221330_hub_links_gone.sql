-- W789: hub links are gone. Their tables go with every key they kept: the links minted here (only each key's SHA-256)
-- and the links kept for projects (each key sealed to the hub's box key). The asks that came in through a link, or
-- went out through one, go with the orders they were linked to, then the columns that marked them.
DROP TABLE hub_links;
DROP TABLE hub_links_issued;
DELETE FROM project_ask_orders WHERE n IN (SELECT n FROM project_asks WHERE via_link IS NOT NULL OR to_hub IS NOT NULL);
DELETE FROM project_asks WHERE via_link IS NOT NULL OR to_hub IS NOT NULL;
DROP INDEX project_asks_by_remote;
ALTER TABLE project_asks DROP COLUMN via_link;
ALTER TABLE project_asks DROP COLUMN to_hub;
ALTER TABLE project_asks DROP COLUMN remote;
