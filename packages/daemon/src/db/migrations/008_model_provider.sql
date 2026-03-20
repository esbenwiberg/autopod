-- Add multi-provider model authentication support to profiles.
-- model_provider: 'anthropic' (default) | 'max' | 'foundry'
-- provider_credentials: JSON blob with provider-specific credentials (shape depends on model_provider)
ALTER TABLE profiles ADD COLUMN model_provider TEXT NOT NULL DEFAULT 'anthropic';
ALTER TABLE profiles ADD COLUMN provider_credentials TEXT DEFAULT NULL;
