-- Migration 005: Create suspicious_activity table for AML/Fraud velocity tracking

CREATE TABLE IF NOT EXISTS suspicious_activity (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  action VARCHAR(100) NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details JSONB
);

CREATE INDEX IF NOT EXISTS idx_suspicious_activity_user_time 
ON suspicious_activity (user_id, timestamp DESC);
