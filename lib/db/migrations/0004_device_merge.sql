ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS merged_into_device_id uuid;

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS merged_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'devices_merged_into_device_id_fkey'
  ) THEN
    ALTER TABLE devices
      ADD CONSTRAINT devices_merged_into_device_id_fkey
      FOREIGN KEY (merged_into_device_id)
      REFERENCES devices(id)
      ON DELETE SET NULL;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS devices_merged_into_device_idx
  ON devices(merged_into_device_id);