-- New mail for a Navi (W97): when the last read of the Pub/Sub subscription worked, or why it didn't, so the hub
-- knows whether it hears mail by push or polls for it.
CREATE TABLE google_mail_state (id INTEGER PRIMARY KEY CHECK (id = 1), pulled_ms INTEGER, problem TEXT);
