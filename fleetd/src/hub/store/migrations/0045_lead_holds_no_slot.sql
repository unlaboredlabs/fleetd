-- A lead holds no slot: it is not an agent.
DELETE FROM slot_claims WHERE priority = 'lead';
