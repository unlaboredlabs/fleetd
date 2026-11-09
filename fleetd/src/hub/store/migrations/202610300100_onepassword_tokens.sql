-- D235: each person's 1Password service account token. One row per person, `data` as onepassword_get shows it (each
-- node's fingerprint and the last Test), never the token.
CREATE TABLE onepassword_tokens (person_id TEXT PRIMARY KEY, data TEXT NOT NULL);
