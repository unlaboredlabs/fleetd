-- Each Navi has an owner (D215): the person behind the key that made it, else the hub's first owner. Only the owner
-- sees and manages it. A Navi from a hub with no people yet gets its owner at the hub's next start, which makes one
-- (`people::ensure_owner_on`); until then it is nobody's, and it reads as before people.
ALTER TABLE assistants ADD COLUMN owner_person TEXT;
  UPDATE assistants SET owner_person = COALESCE(
    (SELECT k.person_id FROM agent_keys k WHERE k.key_id = assistants.created_by_key),
    (SELECT person_id FROM people WHERE role = 'owner' AND removed_ms IS NULL ORDER BY created_ms, rowid LIMIT 1));
  CREATE INDEX assistants_by_owner ON assistants (owner_person);
