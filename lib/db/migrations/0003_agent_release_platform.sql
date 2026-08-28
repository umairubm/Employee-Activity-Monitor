-- Keep Windows as the compatibility default for releases created before
-- platform-specific macOS remote updates were introduced.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agent_release_platform') THEN
    CREATE TYPE agent_release_platform AS ENUM ('windows', 'macos');
  END IF;
END$$;

ALTER TABLE agent_releases
  ADD COLUMN IF NOT EXISTS platform agent_release_platform NOT NULL DEFAULT 'windows';