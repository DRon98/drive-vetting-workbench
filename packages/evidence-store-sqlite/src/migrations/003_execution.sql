CREATE TABLE execution_runs (
  run_id TEXT PRIMARY KEY,
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 64),
  approval_checksum TEXT NOT NULL CHECK (length(approval_checksum) = 64),
  provider_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  started_at TEXT NOT NULL,
  UNIQUE (plan_hash, approval_checksum, attempt)
) STRICT;

CREATE INDEX execution_runs_by_plan
  ON execution_runs (plan_hash, approval_checksum, attempt);

CREATE TABLE execution_run_events (
  event_id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES execution_runs (run_id),
  event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'RunStarted',
      'ResumeValidated',
      'ActionVerified',
      'ActionFailed',
      'RunCompleted',
      'RunFailed'
    )
  ),
  state TEXT NOT NULL CHECK (
    state IN ('Started', 'Running', 'Completed', 'Partial', 'Failed')
  ),
  action_id TEXT,
  occurred_at TEXT NOT NULL,
  detail_json TEXT NOT NULL CHECK (
    json_valid(detail_json)
    AND json_type(detail_json) = 'object'
  ),
  UNIQUE (run_id, event_sequence)
) STRICT;

CREATE INDEX execution_events_by_run
  ON execution_run_events (run_id, event_sequence);

CREATE TABLE execution_receipts (
  receipt_id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES execution_runs (run_id),
  action_id TEXT NOT NULL,
  action_index INTEGER NOT NULL CHECK (action_index >= 0),
  action_type TEXT NOT NULL CHECK (
    action_type IN ('RENAME', 'CREATE_SHORTCUT')
  ),
  disposition TEXT NOT NULL CHECK (
    disposition IN ('Failed', 'MutationAccepted', 'NoOp')
  ),
  target_id_sha256 TEXT NOT NULL CHECK (length(target_id_sha256) = 64),
  observed_item_id_sha256 TEXT CHECK (
    observed_item_id_sha256 IS NULL OR length(observed_item_id_sha256) = 64
  ),
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  request_json TEXT CHECK (request_json IS NULL OR json_valid(request_json)),
  provider_response_json TEXT CHECK (
    provider_response_json IS NULL OR json_valid(provider_response_json)
  ),
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  verification_status TEXT NOT NULL CHECK (
    verification_status IN ('Verified', 'Failed')
  ),
  failure_code TEXT,
  recorded_at TEXT NOT NULL,
  UNIQUE (run_id, action_id),
  CHECK (
    verification_status = 'Failed'
    OR (before_json IS NOT NULL AND after_json IS NOT NULL)
  )
) STRICT;

CREATE INDEX execution_receipts_by_action_history
  ON execution_receipts (action_id, receipt_id);

CREATE TRIGGER execution_runs_are_immutable_on_update
BEFORE UPDATE ON execution_runs
BEGIN
  SELECT RAISE(ABORT, 'Execution runs are immutable.');
END;

CREATE TRIGGER execution_runs_are_immutable_on_delete
BEFORE DELETE ON execution_runs
BEGIN
  SELECT RAISE(ABORT, 'Execution runs are immutable.');
END;

CREATE TRIGGER execution_events_are_immutable_on_update
BEFORE UPDATE ON execution_run_events
BEGIN
  SELECT RAISE(ABORT, 'Execution events are immutable.');
END;

CREATE TRIGGER execution_events_are_immutable_on_delete
BEFORE DELETE ON execution_run_events
BEGIN
  SELECT RAISE(ABORT, 'Execution events are immutable.');
END;

CREATE TRIGGER execution_receipts_are_immutable_on_update
BEFORE UPDATE ON execution_receipts
BEGIN
  SELECT RAISE(ABORT, 'Execution receipts are immutable.');
END;

CREATE TRIGGER execution_receipts_are_immutable_on_delete
BEFORE DELETE ON execution_receipts
BEGIN
  SELECT RAISE(ABORT, 'Execution receipts are immutable.');
END;
