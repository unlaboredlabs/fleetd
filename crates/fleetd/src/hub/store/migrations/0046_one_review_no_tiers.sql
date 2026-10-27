-- Every PR merges on one fresh review plus green CI: no tiers, and no waived reviews.
DROP TABLE IF EXISTS review_waivers;
  UPDATE workstreams SET data = json_remove(data, '$.brief.tier') WHERE json_valid(data);
  UPDATE tasks SET data = json_remove(data, '$.tier') WHERE json_valid(data);
  UPDATE changes SET data = json_remove(data, '$.tier') WHERE json_valid(data);
