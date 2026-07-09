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

/**
 * Effective wall-clock offset for an instant: the device-reported offset when
 * present, else the org timezone's offset *at that instant* (DST-correct),
 * else null (browser-local rendering).
 */
export function resolveDeviceOffset(
  at: Date,
  offsetMinutes: number | null | undefined,
  fallbackZone?: string | null,
): number | null {
  if (offsetMinutes != null) return offsetMinutes;
  if (fallbackZone) return zoneOffsetMinutes(fallbackZone, at);
  return null;
}

/**
 * Format an instant in the device's wall-clock time. Fallback chain:
 * device-reported offset → org timezone (`fallbackZone`, resolved per instant
 * so DST transitions render correctly) → browser-local.
 */
export function formatDeviceTime(
  value: string | Date,
  offsetMinutes: number | null | undefined,
  fmt: string,
  fallbackZone?: string | null,
): string {
  const d = typeof value === "string" ? new Date(value) : value;
  const off = resolveDeviceOffset(d, offsetMinutes, fallbackZone);
  return format(off == null ? d : deviceWallDate(d, off), fmt);
}

/** deviceId -> reported wall-clock offset (minutes), for pages showing mixed devices. */
export function deviceTzMap(
  devices: DeviceItem[] | undefined,
): Map<string, number | null> {
  const map = new Map<string, number | null>();
  devices?.forEach((d) => map.set(d.id, d.tzOffsetMinutes ?? null));
  return map;
}

/**
 * Current UTC offset (minutes east) of an IANA timezone. Used as the org-wide
 * fallback when a device hasn't reported its own offset yet (older agents):
 * rendering in the browser's timezone breaks when the viewer's OS timezone is
 * misconfigured (a common setup is a wrong region with the clock adjusted by
 * hand — the wall clock looks right but JS renders instants hours off).
 * Returns null for an unknown/invalid zone.
 */
export function zoneOffsetMinutes(timeZone: string, at: Date = new Date()): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(at);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const asUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour") % 24,
      get("minute"),
      get("second"),
    );
    return Math.round((asUtc - at.getTime()) / 60_000);
  } catch {
    return null;
  }
}
