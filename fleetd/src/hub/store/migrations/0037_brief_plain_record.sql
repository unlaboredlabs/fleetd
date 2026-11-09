-- A brief is a plain record: no freeze hash, no amends.
ALTER TABLE workstreams DROP COLUMN amends;
  UPDATE workstreams SET data = json_remove(data, '$.briefHash') WHERE json_valid(data);
