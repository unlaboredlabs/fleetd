-- Outbound webhooks went: external clients long-poll events_wait.
DROP TABLE subscriptions;
  DELETE FROM events WHERE type = 'webhook.failing';
