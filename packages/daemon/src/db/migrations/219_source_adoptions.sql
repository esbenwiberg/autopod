-- @execute-whole
CREATE TABLE source_adoptions (
  id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  binding TEXT NOT NULL CHECK(json_valid(binding)),
  actor TEXT NOT NULL CHECK(json_valid(actor)),
  reason TEXT NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('claimed','preserved','applying','adopted','checking','checked')),
  preservation TEXT CHECK(json_valid(preservation)),
  adopted_generation INTEGER,
  validation_hash TEXT,
  validation_result TEXT CHECK(validation_result IN ('pass','fail')),
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK((preservation IS NOT NULL) = (stage!='claimed')),
  CHECK((adopted_generation IS NOT NULL) = (stage NOT IN ('claimed','preserved'))),
  CHECK(adopted_generation IS NULL OR adopted_generation = json_extract(binding,'$.generation')+1),
  CHECK((validation_hash IS NOT NULL) = (stage='checked')),
  CHECK((validation_result IS NOT NULL) = (stage='checked')),
  CHECK(validation_hash IS NULL OR (length(validation_hash)=64 AND validation_hash NOT GLOB '*[^0-9a-f]*')),
  CHECK((completed_at IS NOT NULL) = (stage='checked'))
);
CREATE UNIQUE INDEX source_adoption_one_active ON source_adoptions(task_id) WHERE completed_at IS NULL;
CREATE TABLE source_adoption_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  adoption_id TEXT NOT NULL REFERENCES source_adoptions(id),
  event TEXT NOT NULL CHECK(json_valid(event)),
  created_at TEXT NOT NULL
);
CREATE TRIGGER source_adoption_no_delete BEFORE DELETE ON source_adoptions
BEGIN SELECT RAISE(ABORT,'Source adoption custody cannot be erased'); END;
CREATE TRIGGER source_adoption_guard BEFORE UPDATE ON source_adoptions
WHEN NEW.id IS NOT OLD.id OR NEW.pod_id IS NOT OLD.pod_id OR NEW.task_id IS NOT OLD.task_id
 OR NEW.binding IS NOT OLD.binding OR NEW.actor IS NOT OLD.actor OR NEW.reason IS NOT OLD.reason
 OR NEW.created_at IS NOT OLD.created_at OR OLD.completed_at IS NOT NULL
 OR (OLD.preservation IS NOT NULL AND NEW.preservation IS NOT OLD.preservation)
 OR (OLD.adopted_generation IS NOT NULL AND NEW.adopted_generation IS NOT OLD.adopted_generation)
 OR (OLD.validation_hash IS NOT NULL AND NEW.validation_hash IS NOT OLD.validation_hash)
 OR (OLD.validation_result IS NOT NULL AND NEW.validation_result IS NOT OLD.validation_result)
 OR NOT (NEW.stage = OLD.stage
   OR (OLD.stage='claimed' AND NEW.stage='preserved')
   OR (OLD.stage='preserved' AND NEW.stage='applying')
   OR (OLD.stage='applying' AND NEW.stage='adopted')
   OR (OLD.stage='adopted' AND NEW.stage='checking')
   OR (OLD.stage='checking' AND NEW.stage='checked'))
 OR ((NEW.completed_at IS NOT NULL) != (NEW.stage='checked'))
BEGIN SELECT RAISE(ABORT,'Source adoption transition or evidence is immutable'); END;
CREATE TRIGGER source_adoption_events_no_update BEFORE UPDATE ON source_adoption_events
BEGIN SELECT RAISE(ABORT,'Source adoption observations are immutable'); END;
CREATE TRIGGER source_adoption_events_no_delete BEFORE DELETE ON source_adoption_events
BEGIN SELECT RAISE(ABORT,'Source adoption observations are immutable'); END;
