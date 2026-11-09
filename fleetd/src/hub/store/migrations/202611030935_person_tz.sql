-- W352: a person's time zone, the one their app or phone last sent with a chat message (hub/people/zone). A lead
-- reads each of their messages with the time there, and a schedule it makes without a zone runs in it.
ALTER TABLE people ADD COLUMN tz TEXT;
