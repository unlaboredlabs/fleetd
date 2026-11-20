-- W742: a lead's text that answers another (`project_message` with reply: "N<n>") keeps the n it answers, so a retry
-- of one answer is never taken for another answer with the same words.
ALTER TABLE project_asks ADD COLUMN reply INTEGER;
