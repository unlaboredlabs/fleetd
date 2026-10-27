-- M7 reviews: the review tasks spawned for each Change with the patch id their round was for, each verdict bound to
-- the patch id of the head it reviewed, the patch id of each head seen, and patches the polish-loop rule waived.
CREATE TABLE review_tasks (
    task_id TEXT PRIMARY KEY, change_id TEXT NOT NULL, role TEXT NOT NULL, patch_id TEXT NOT NULL
  );
  CREATE INDEX review_tasks_by_change ON review_tasks (change_id);
  CREATE TABLE review_bindings (
    task_id TEXT NOT NULL, pr_head_sha TEXT NOT NULL, patch_id TEXT NOT NULL, blocking INTEGER NOT NULL,
    non_blocking INTEGER NOT NULL, PRIMARY KEY (task_id, pr_head_sha)
  );
  CREATE TABLE review_patch_ids (
    change_id TEXT NOT NULL, head_sha TEXT NOT NULL, patch_id TEXT NOT NULL, PRIMARY KEY (change_id, head_sha)
  );
  CREATE TABLE review_waivers (
    change_id TEXT NOT NULL, patch_id TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY (change_id, patch_id)
  );
