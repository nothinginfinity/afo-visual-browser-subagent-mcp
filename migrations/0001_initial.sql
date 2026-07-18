CREATE TABLE IF NOT EXISTS visual_runs (
  run_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  target_url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  receipt_key TEXT,
  viewport_count INTEGER NOT NULL DEFAULT 1,
  duration_ms INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_visual_runs_created_at ON visual_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_visual_runs_target_url ON visual_runs(target_url);

CREATE TABLE IF NOT EXISTS visual_skills (
  skill_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  triggers_json TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  verification_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
