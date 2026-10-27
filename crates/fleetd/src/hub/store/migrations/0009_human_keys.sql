-- Human keys (a person's device): their answers are recorded as the human's.
ALTER TABLE agent_keys ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent';
