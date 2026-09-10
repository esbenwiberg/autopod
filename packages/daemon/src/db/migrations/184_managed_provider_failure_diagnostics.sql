-- Durable, bounded diagnostics for uncertain managed provider requests. Historical rows remain unknown.
ALTER TABLE managed_provider_requests ADD COLUMN failure_phase TEXT
  CHECK(failure_phase IS NULL OR failure_phase IN (
    'request','credential','http','stream','response-schema','model','usage','artifact','wire-response'
  ));
ALTER TABLE managed_provider_requests ADD COLUMN failure_reason TEXT
  CHECK(failure_reason IS NULL OR failure_reason IN (
    'account','http','incomplete','duplicate-completion','response-limit','usage',
    'artifact-size','output-size','unclassified'
  ));
ALTER TABLE managed_provider_requests ADD COLUMN failure_http_status INTEGER
  CHECK(failure_http_status IS NULL OR failure_http_status BETWEEN 100 AND 599);
