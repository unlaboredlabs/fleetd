-- Status shows work in groups, not a figure: plans and the bar's series go, and a claim keeps its other keys.
DROP TABLE plan_items;
  DROP TABLE plan_changes;
  DROP TABLE plan_milestones;
  DROP TABLE status_series;
  UPDATE work_claims SET data = json_set(data, '$.keys', (SELECT json_group_array(json(k.value))
      FROM json_each(work_claims.data, '$.keys') AS k WHERE json_type(k.value, '$.item') IS NULL))
    WHERE json_valid(data)
      AND EXISTS (SELECT 1 FROM json_each(work_claims.data, '$.keys') AS k WHERE json_type(k.value, '$.item') IS NOT NULL);
