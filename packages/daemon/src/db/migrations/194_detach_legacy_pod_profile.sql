-- @detach-legacy-pod-profile
-- The runner rebuilds the accumulated pod schema, removing only its profiles(name) FK.
-- Legacy names remain historical data. New launches bind a configuration ID and frozen snapshot.
PRAGMA foreign_keys = OFF;
