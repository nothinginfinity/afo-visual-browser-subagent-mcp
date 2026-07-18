CREATE TABLE IF NOT EXISTS visual_runs (
  run_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  target_url TEXT NOT NULL,
  redacted_url TEXT NOT NULL,
  final_url TEXT,
  hostname TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  viewport_name TEXT,
  viewport_width INTEGER,
  viewport_height INTEGER,
  artifact_keys_json TEXT NOT NULL DEFAULT '{}',
  receipt_key TEXT,
  console_error_count INTEGER NOT NULL DEFAULT 0,
  failed_request_count INTEGER NOT NULL DEFAULT 0,
  failed_response_count INTEGER NOT NULL DEFAULT 0,
  navigation_duration_ms INTEGER NOT NULL DEFAULT 0,
  render_duration_ms INTEGER NOT NULL DEFAULT 0,
  screenshot_duration_ms INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  queue_status TEXT NOT NULL DEFAULT 'synchronous',
  vector_status TEXT NOT NULL DEFAULT 'not_started',
  error_class TEXT,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_visual_runs_created_at ON visual_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_visual_runs_hostname ON visual_runs(hostname);
CREATE INDEX IF NOT EXISTS idx_visual_runs_status ON visual_runs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_visual_runs_target_url ON visual_runs(redacted_url);
CREATE TABLE IF NOT EXISTS audit_jobs (
  job_id TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL,
  type TEXT NOT NULL,
  target_url TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_jobs_investigation_id ON audit_jobs(investigation_id);
CREATE INDEX IF NOT EXISTS idx_audit_jobs_status ON audit_jobs(status, updated_at DESC);
CREATE TABLE IF NOT EXISTS visual_skills (
  skill_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  triggers_json TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  verification_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
