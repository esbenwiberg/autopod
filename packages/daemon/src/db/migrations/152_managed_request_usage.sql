-- Request-time mode keeps unknown usage NULL. Prior journals and native rows remain unchanged.
ALTER TABLE managed_provider_requests ADD COLUMN actual_tokens INTEGER CHECK(actual_tokens >= 0);
