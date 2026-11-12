-- Only me is gone (D491): every project is everyone's on its hub. A former Only me project becomes an ordinary one.
-- On a hub with more than one person still on it, those are archived too, so they don't turn up in teammates'
-- sidebars uninvited; their owners bring them back from the archive. On a one-person hub nothing visible changes.
-- `only_me` and `owner_person` stay as columns, no longer read: an export carries them, and fleetd cloud reads this
-- package's tables until its own removal.
UPDATE project_settings SET archived_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
  WHERE only_me = 1 AND archived_ms IS NULL AND (SELECT COUNT(*) FROM people WHERE removed_ms IS NULL) > 1;
UPDATE project_settings SET only_me = 0 WHERE only_me = 1;
