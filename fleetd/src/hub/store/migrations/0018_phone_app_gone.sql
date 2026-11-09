-- The phone web app is gone, and with it device pairing links and Web Push. Its push.sent events go too: the
-- event type no longer exists, so they would not decode.
DROP TABLE pair_tokens;
  DROP TABLE push_subscriptions;
  DELETE FROM events WHERE type = 'push.sent';
