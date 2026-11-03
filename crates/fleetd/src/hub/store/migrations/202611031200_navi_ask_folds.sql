-- W364: a lead may fold a Navi's later ask into an order already open for another (`brief` with workstreamId and
-- asked), so an order now has one ask or several: keyed by both, in the order they were linked.
CREATE TABLE navi_ask_orders_next (workstream_id TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (workstream_id, n));
INSERT INTO navi_ask_orders_next (workstream_id, n) SELECT workstream_id, n FROM navi_ask_orders ORDER BY rowid;
DROP TABLE navi_ask_orders;
ALTER TABLE navi_ask_orders_next RENAME TO navi_ask_orders;
CREATE INDEX navi_ask_orders_by_n ON navi_ask_orders (n);
