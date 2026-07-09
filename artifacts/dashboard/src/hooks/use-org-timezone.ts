import {
  useGetAttendanceSettings,
  getGetAttendanceSettingsQueryKey,
} from "@workspace/api-client-react";

/**
 * Org-wide IANA timezone from Attendance settings, used as the fallback for
 * devices that haven't reported their own `tzOffsetMinutes` (agents older
 * than the tz feature). Pass it as the `fallbackZone` argument of
 * `formatDeviceTime` / `resolveDeviceOffset`, which resolve the offset per
 * instant so DST transitions render correctly.
 *
 * Returns null when the org timezone is unset/"UTC" (the untouched default —
 * indistinguishable from "not configured", so we keep the old browser-local
 * rendering); callers then fall back to browser-local time.
 */
export function useOrgTimezone(): string | null {
  const { data } = useGetAttendanceSettings({
    query: { queryKey: getGetAttendanceSettingsQueryKey() },
  });
  const timezone = data?.timezone;
  return !timezone || timezone === "UTC" ? null : timezone;
}
