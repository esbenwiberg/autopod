-- Add network policy column to profiles
ALTER TABLE profiles ADD COLUMN network_policy TEXT DEFAULT NULL;
