-- Add fallback_model column to profiles table.
-- When the primary model fails with a non-retryable error, this model identifier
-- is surfaced in the failure metadata so callers can decide to retry with it.
ALTER TABLE profiles ADD COLUMN fallback_model TEXT;
