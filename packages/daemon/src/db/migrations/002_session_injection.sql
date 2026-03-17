-- Add injection columns to profiles (stored as JSON arrays)
ALTER TABLE profiles ADD COLUMN mcp_servers TEXT NOT NULL DEFAULT '[]';
ALTER TABLE profiles ADD COLUMN claude_md_sections TEXT NOT NULL DEFAULT '[]';
