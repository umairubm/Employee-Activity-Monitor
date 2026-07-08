import { format } from "date-fns";
import type { DeviceItem } from "@workspace/api-client-react";

/**
 * Device-local time display (QA bug: activity/screenshot times rendered in the
 * *viewer's* browser timezone, so an admin in another timezone — or a browser
 * whose tz differs from the OS clock — saw e.g. "2:23 AM" for work done at
 * 2:23 PM device time).
 *
 * Each agent reports its wall-clock offset (minutes relative to the UTC
 * instants it stores) on every heartbeat; it is persisted per device as
 * `tzOffsetMinutes`. These helpers shift an instant by that offset so
 * `date-fns format` renders the wall time the device user actually saw.
 * When a device hasn't reported an offset yet (null/undefined), we fall back
 * to browser-local time — the old behavior.
 */

/**
 * Returns a Date whose *local* getters render the device's wall-clock time
 * for the given instant. Standard "shifted date" trick: only use the result
 * for formatting/bucketing, never as a real instant.
 */
export function deviceWallDate(value: string | Date, offsetMinutes: number): Date {
  const d = typeof value === "string" ? new Date(value) : value;
  const shifted = new Date(d.getTime() + offsetMinutes * 60_000);
  // Cancel out the viewer's own timezone so local getters show UTC fields of
  // `shifted`, i.e. the device wall clock.
  return new Date(shifted.getTime() + shifted.getTimezoneOffset() * 60_000);
}

/** Format an instant in the device's wall-clock time (browser-local if the device hasn't reported an offset). */
export function formatDeviceTime(
  value: string | Date,
  offsetMinutes: number | null | undefined,
  fmt: string,
): string {
  const d = typeof value === "string" ? new Date(value) : value;
  return format(offsetMinutes == null ? d : deviceWallDate(d, offsetMinutes), fmt);
}

/** deviceId -> reported wall-clock offset (minutes), for pages showing mixed devices. */
export function deviceTzMap(
  devices: DeviceItem[] | undefined,
): Map<string, number | null> {
  const map = new Map<string, number | null>();
  devices?.forEach((d) => map.set(d.id, d.tzOffsetMinutes ?? null));
  return map;
}
