-- Research has no pre-registered rule, computed verdict or turn budget: the lead closes it with the answer.
UPDATE workstreams SET data = json_remove(data, '$.outcome', '$.verdict', '$.brief.budget', '$.brief.baseline',
    '$.brief.metric', '$.brief.decisionRule') WHERE json_valid(data);
  DELETE FROM events WHERE type = 'research.verdict';
