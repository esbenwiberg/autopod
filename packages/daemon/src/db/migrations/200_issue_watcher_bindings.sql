-- @detach-legacy-watched-profile
PRAGMA foreign_keys = OFF;
CREATE TABLE issue_watcher_bindings (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(revision > 0),
  owner_user_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
ALTER TABLE watched_issues ADD COLUMN watcher_id TEXT;
CREATE INDEX watched_issues_watcher ON watched_issues(watcher_id);
PRAGMA foreign_keys = ON;
