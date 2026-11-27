-- An explicitly retired draft create retains its audit row and exact-source
-- uniqueness; only the temporary active-operation fence is released.
DROP INDEX saved_work_draft_pr_active;
CREATE UNIQUE INDEX saved_work_draft_pr_active ON saved_work_draft_pr_operations(pod_id)
  WHERE json_extract(body, '$.state') NOT IN ('published','cancelled','retired-uncertain');
