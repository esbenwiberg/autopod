-- Display-only estimates, never used as validation evidence or admission input.
CREATE TABLE validation_phase_timings (
  timing_key TEXT PRIMARY KEY,
  durations_ms TEXT NOT NULL
);
