-- A person's wait for a screen can name a PR whose CI build goes into it when it opens (D239): its repo and number.
ALTER TABLE screen_waits ADD COLUMN pr_repo TEXT;
ALTER TABLE screen_waits ADD COLUMN pr_number INTEGER;
