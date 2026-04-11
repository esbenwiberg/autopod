-- Profile-level token budget configuration
ALTER TABLE profiles ADD COLUMN token_budget INTEGER DEFAULT NULL;          -- null = unlimited
ALTER TABLE profiles ADD COLUMN token_budget_warn_at REAL NOT NULL DEFAULT 0.8; -- fraction [0,1)
ALTER TABLE profiles ADD COLUMN token_budget_policy TEXT NOT NULL DEFAULT 'soft'; -- 'soft'|'hard'
ALTER TABLE profiles ADD COLUMN max_budget_extensions INTEGER DEFAULT NULL; -- null = unlimited

-- Session-level token budget override and state
ALTER TABLE sessions ADD COLUMN token_budget INTEGER DEFAULT NULL;
ALTER TABLE sessions ADD COLUMN budget_extensions_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN pause_reason TEXT DEFAULT NULL;             -- 'budget' | 'manual'
