-- Receipts contain hashes/roles only, never images or reference filenames.
-- Historical reviews remain unclassified (NULL), not retroactively image-reviewed.
ALTER TABLE isolated_reviewer_runs ADD COLUMN input_evidence TEXT;
