-- W600: people's reviews on GitHub. Each PR's open findings as its last good read found them, each finding already sent
-- to its writer, and the comment the agent's review is posted in on each PR, with its rounds.
CREATE TABLE review_people (pr_key TEXT PRIMARY KEY, read_ms INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE review_people_sent (pr_key TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (pr_key, key));
CREATE TABLE review_posts (pr_key TEXT PRIMARY KEY, comment_id INTEGER NOT NULL, rounds TEXT NOT NULL);
