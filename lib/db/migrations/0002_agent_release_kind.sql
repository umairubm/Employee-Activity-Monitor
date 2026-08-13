-- Agent releases can be a full installer (.exe) or a lightweight code patch (.zip).
-- Delivery is identical; only the agent-side apply step differs.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agent_release_kind') THEN
    CREATE TYPE agent_release_kind AS ENUM ('installer', 'patch');
  END IF;
END$$;

ALTER TABLE agent_releases
  ADD COLUMN IF NOT EXISTS kind agent_release_kind NOT NULL DEFAULT 'installer';
