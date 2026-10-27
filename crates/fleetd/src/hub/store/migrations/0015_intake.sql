-- M9 intake: each intent the router placed or asked about, so a retry returns the same answer and the routing
-- ask's answer finds its intent.
CREATE TABLE intake_routes (client_request_id TEXT PRIMARY KEY, ask_id TEXT UNIQUE, data TEXT NOT NULL);
