-- No value bar: tasks and changes no longer say what they serve.
UPDATE tasks SET data = json_remove(data, '$.serves') WHERE json_valid(data);
  UPDATE changes SET data = json_remove(data, '$.serves') WHERE json_valid(data);
