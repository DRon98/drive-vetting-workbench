CREATE TABLE decisions (
  decision_id TEXT PRIMARY KEY,
  question_key TEXT NOT NULL,
  answer_json TEXT NOT NULL CHECK (json_valid(answer_json)),
  approver TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL CHECK (
    json_valid(evidence_ids_json)
    AND json_type(evidence_ids_json) = 'array'
  ),
  policy_version TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (
    scope_type IN ('item', 'folder', 'deal', 'document-type', 'global')
  ),
  scope_id TEXT,
  created_time TEXT NOT NULL,
  supersedes_decision_id TEXT UNIQUE REFERENCES decisions (decision_id),
  provenance TEXT NOT NULL CHECK (provenance = 'HumanDecision'),
  CHECK (
    (scope_type = 'global' AND scope_id IS NULL)
    OR (scope_type <> 'global' AND scope_id IS NOT NULL AND length(scope_id) > 0)
  )
) STRICT;

CREATE INDEX decisions_by_question_history
  ON decisions (question_key, created_time, decision_id);

CREATE UNIQUE INDEX decisions_one_root_per_question
  ON decisions (question_key)
  WHERE supersedes_decision_id IS NULL;

CREATE TABLE active_decisions (
  question_key TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL UNIQUE REFERENCES decisions (decision_id)
) STRICT;

CREATE TRIGGER decision_supersession_must_match
BEFORE INSERT ON decisions
WHEN NEW.supersedes_decision_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM decisions AS prior
    WHERE prior.decision_id = NEW.supersedes_decision_id
      AND prior.question_key = NEW.question_key
      AND prior.scope_type = NEW.scope_type
      AND prior.scope_id IS NEW.scope_id
  )
BEGIN
  SELECT RAISE(ABORT, 'A superseded decision must match the question scope.');
END;

CREATE TRIGGER active_decision_insert_must_match
BEFORE INSERT ON active_decisions
WHEN NOT EXISTS (
  SELECT 1
  FROM decisions AS decision
  WHERE decision.decision_id = NEW.decision_id
    AND decision.question_key = NEW.question_key
)
BEGIN
  SELECT RAISE(ABORT, 'The active decision must match its question key.');
END;

CREATE TRIGGER active_decision_update_must_match
BEFORE UPDATE ON active_decisions
WHEN NOT EXISTS (
  SELECT 1
  FROM decisions AS decision
  WHERE decision.decision_id = NEW.decision_id
    AND decision.question_key = NEW.question_key
)
BEGIN
  SELECT RAISE(ABORT, 'The active decision must match its question key.');
END;

CREATE TRIGGER active_decision_update_must_advance
BEFORE UPDATE ON active_decisions
WHEN NOT EXISTS (
  SELECT 1
  FROM decisions AS decision
  WHERE decision.decision_id = NEW.decision_id
    AND decision.question_key = OLD.question_key
    AND decision.supersedes_decision_id = OLD.decision_id
)
BEGIN
  SELECT RAISE(ABORT, 'The active decision must advance by explicit supersession.');
END;

CREATE TRIGGER active_decisions_cannot_be_deleted
BEFORE DELETE ON active_decisions
BEGIN
  SELECT RAISE(ABORT, 'Active decision pointers cannot be deleted.');
END;

CREATE TRIGGER decisions_are_immutable_on_update
BEFORE UPDATE ON decisions
BEGIN
  SELECT RAISE(ABORT, 'Decision history is immutable.');
END;

CREATE TRIGGER decisions_are_immutable_on_delete
BEFORE DELETE ON decisions
BEGIN
  SELECT RAISE(ABORT, 'Decision history is immutable.');
END;
