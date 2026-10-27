-- What the other hub's `hello` said of a kept link (W104), for the Navi's Linked hubs: `who`, the person it acts as
-- there, and `projects`, the projects it is limited to (JSON `LinkProject`s; NULL: every project its person reaches,
-- or a hub that doesn't say). Read again at each add and each time the link's follower starts.
ALTER TABLE hub_links ADD COLUMN who TEXT;
ALTER TABLE hub_links ADD COLUMN projects TEXT;
