-- @execute-whole
CREATE TABLE configuration_cutover (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  receipt TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER configuration_cutover_no_update
BEFORE UPDATE ON configuration_cutover BEGIN
  SELECT RAISE(ABORT, 'Configuration cutover receipt is immutable');
END;
CREATE TRIGGER configuration_cutover_no_delete
BEFORE DELETE ON configuration_cutover BEGIN
  SELECT RAISE(ABORT, 'Configuration cutover receipt is immutable');
END;
