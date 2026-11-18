-- Two reads that scanned every bot's whole chat (W701), each now through an index of only the rows it wants.
-- Unsettled items: the messages whose item still reads open or approved. The chat state reads a bot's open ones for
-- every bot on each status and connect, and the hub's start reads them all. `chat::openItems` and
-- `chat::unsettledRequests` ask with this same condition.
CREATE INDEX chat_items_unsettled ON chat_messages (machine_id, project_id, seq)
    WHERE json_extract(data, '$.item.state') IN ('open', 'approved');
-- Held messages: the hub's start and its retry every minute look for them in every bot (`chat::heldProjects`, `held`).
CREATE INDEX chat_held ON chat_messages (machine_id, project_id, seq) WHERE held = 1;
