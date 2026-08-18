/**
 * Hardware-identity fields that raise a change alert when their value changes.
 *
 * These keys match the snapshot the agent posts on the activity route. Volatile
 * values that legitimately change all the time — `Ip` and `Available Space` —
 * are deliberately excluded: they are stored in the device snapshot but never
 * produce alerts (per product decision).
 */
export const ALERT_FIELDS = [
  "Processor",
  "CPU",
  "CPU_Core",
  "OS Version",
  "Operating System",
  "Host Name",
  "Total Disk Space",
  "HD Size",
  "HD_Type",
  "Manufacturer",
  "Model",
  "Ram_Type",
  "Ram_Size",
  "Serial_Number",
  "USB_Devices",
] as const;

export type SnapshotValue = string | number | boolean | null;
export type Snapshot = Record<string, SnapshotValue>;

export interface SpecChange {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

function norm(v: SnapshotValue | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/**
 * Compare a previous snapshot to an incoming one over the alert allowlist.
 * Returns one change per tracked field whose value changed. The first snapshot
 * (no previous) produces no changes — there is nothing to compare against. A
 * field is only reported when both the old and new values are present and
 * differ, so appearing/disappearing fields don't create noise.
 */
export function diffSystemInfo(
  prev: Snapshot | null | undefined,
  next: Snapshot,
): SpecChange[] {
  if (!prev) return [];
  const changes: SpecChange[] = [];
  for (const field of ALERT_FIELDS) {
    const oldValue = norm(prev[field]);
    const newValue = norm(next[field]);
    if (oldValue !== null && newValue !== null && oldValue !== newValue) {
      changes.push({ field, oldValue, newValue });
    }
  }
  return changes;
}

/** Merge an incoming snapshot over the stored one so unsent keys are retained. */
export function mergeSnapshot(
  prev: Snapshot | null | undefined,
  next: Snapshot,
): Snapshot {
  return { ...(prev ?? {}), ...next };
}
