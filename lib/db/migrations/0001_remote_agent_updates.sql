-- Remote Agent Update Manager
-- Safe to run repeatedly: all additions are guarded for existing environments.

ALTER TYPE command_type ADD VALUE IF NOT EXISTS 'update_agent';
ALTER TYPE command_status ADD VALUE IF NOT EXISTS 'downloading';
ALTER TYPE command_status ADD VALUE IF NOT EXISTS 'installing';

ALTER TABLE device_commands
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS agent_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version text NOT NULL,
  download_url text,
  object_path text,
  file_name text,
  created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_releases_company_created_idx
  ON agent_releases (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS device_commands_priority_idx
  ON device_commands (device_id, status, priority DESC, issued_at ASC);