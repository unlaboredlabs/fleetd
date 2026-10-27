-- A stall is one thread.failed{reason:"stalled"} now; the event that announced a nudge went with the nudge.
DELETE FROM events WHERE type = 'thread.stalled';
