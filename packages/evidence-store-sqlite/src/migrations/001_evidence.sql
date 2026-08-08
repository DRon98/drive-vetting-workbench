CREATE TABLE scan_generations (
  generation_id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('Staging', 'Complete', 'Active', 'Failed', 'Superseded')
  ),
  started_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE TABLE active_generation (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generation_id TEXT REFERENCES scan_generations (generation_id)
) STRICT;

INSERT INTO active_generation (singleton, generation_id) VALUES (1, NULL);

CREATE TABLE items (
  generation_id TEXT NOT NULL REFERENCES scan_generations (generation_id),
  item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  created_time TEXT NOT NULL,
  modified_time TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  shortcut_target_id TEXT,
  trashed INTEGER NOT NULL CHECK (trashed IN (0, 1)),
  content_fingerprint TEXT,
  size_bytes INTEGER,
  extracted_snippet TEXT,
  content_locator TEXT,
  PRIMARY KEY (generation_id, item_id)
) STRICT;

CREATE INDEX items_by_generation_name
  ON items (generation_id, normalized_name, item_id);

CREATE INDEX items_by_generation_fingerprint
  ON items (generation_id, content_fingerprint, size_bytes);

CREATE TABLE relations (
  relation_id INTEGER PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES scan_generations (generation_id),
  source_item_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (
    kind IN ('Parent', 'Shortcut', 'Entity', 'Evidence', 'Proposal', 'Receipt')
  ),
  source_locator TEXT,
  FOREIGN KEY (generation_id, source_item_id)
    REFERENCES items (generation_id, item_id),
  UNIQUE (generation_id, source_item_id, target_id, kind, source_locator)
) STRICT;

CREATE INDEX relations_from_active_node
  ON relations (generation_id, source_item_id, kind, target_id);

CREATE INDEX relations_to_active_node
  ON relations (generation_id, target_id, kind, source_item_id);

CREATE TABLE scan_coverage (
  generation_id TEXT PRIMARY KEY REFERENCES scan_generations (generation_id),
  coverage_json TEXT NOT NULL
) STRICT;

CREATE TABLE scan_issues (
  issue_id INTEGER PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES scan_generations (generation_id),
  code TEXT NOT NULL,
  item_id TEXT,
  detail TEXT NOT NULL
) STRICT;

CREATE INDEX scan_issues_by_generation
  ON scan_issues (generation_id, issue_id);
