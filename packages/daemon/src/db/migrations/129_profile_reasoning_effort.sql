ALTER TABLE profiles ADD COLUMN reasoning_effort TEXT;

UPDATE profiles
SET reasoning_effort = CASE
  WHEN extends IS NULL THEN 'auto'
  ELSE NULL
END;
