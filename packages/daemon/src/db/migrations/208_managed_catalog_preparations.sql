CREATE TABLE managed_catalog_preparations (
  installation_id TEXT NOT NULL,
  preparation_key TEXT NOT NULL,
  descriptor_digest TEXT NOT NULL,
  recipe_json TEXT NOT NULL,
  PRIMARY KEY (installation_id, preparation_key)
);
