-- Source-bound raster derivatives, never active HTML or provider credentials.
CREATE TABLE input_reference_previews (
  bundle_id TEXT NOT NULL REFERENCES input_bundles(id) ON DELETE CASCADE,
  entrypoint TEXT NOT NULL,
  renderer_image TEXT NOT NULL,
  receipt TEXT NOT NULL,
  bytes BLOB NOT NULL,
  -- First successful view is canonical. Retries/image upgrades cannot replace its pixels.
  PRIMARY KEY(bundle_id, entrypoint)
);
