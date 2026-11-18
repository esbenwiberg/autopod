CREATE TABLE saved_work_draft_pr_operations (
  id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  body TEXT NOT NULL,
  UNIQUE(pod_id, request_id)
);
CREATE UNIQUE INDEX saved_work_draft_pr_active ON saved_work_draft_pr_operations(pod_id)
  WHERE json_extract(body, '$.state') NOT IN ('published','cancelled');
CREATE UNIQUE INDEX saved_work_draft_pr_source ON saved_work_draft_pr_operations(
  pod_id, json_extract(body,'$.generation'), json_extract(body,'$.repository'),
  json_extract(body,'$.baseBranch'), json_extract(body,'$.source.commit'),
  json_extract(body,'$.source.tree')
) WHERE json_extract(body,'$.state') != 'cancelled';
CREATE TABLE saved_work_draft_pr_preparation_cancellations (
  pod_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (pod_id,request_id)
);
