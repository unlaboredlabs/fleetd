-- W118: how each new patch after an approved head was re-reviewed. `unchanged` carried the approval of `from_task` at
-- `from_head` over (no review ran), `conflicts` got a short review of the conflict resolution in `files` (one per
-- line), `changed` a full review.
CREATE TABLE review_rebases (
    change_id TEXT NOT NULL, patch_id TEXT NOT NULL, head_sha TEXT NOT NULL, from_task TEXT NOT NULL,
    from_head TEXT NOT NULL, from_base TEXT NOT NULL, base TEXT NOT NULL, outcome TEXT NOT NULL, files TEXT NOT NULL,
    PRIMARY KEY (change_id, patch_id)
  );
