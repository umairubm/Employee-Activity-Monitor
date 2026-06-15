import { z } from "zod/v4";

/**
 * Matches a Postgres FK violation (parent row missing). Drizzle wraps driver
 * errors in a `DrizzleQueryError`, so the pg error (with `code` "23503") may be
 * nested under `.cause` rather than on the top-level error.
 */
export function isForeignKeyViolation(error: unknown): boolean {
  const codeOf = (e: unknown): string | undefined =>
    typeof e === "object" && e !== null && "code" in e
      ? (e as { code?: string }).code
      : undefined;
  if (codeOf(error) === "23503") return true;
  const cause =
    typeof error === "object" && error !== null && "cause" in error
      ? (error as { cause?: unknown }).cause
      : undefined;
  return codeOf(cause) === "23503";
}

/**
 * Calendar-valid `YYYY-MM-DD` date string. Regex alone accepts impossible dates
 * (e.g. `2026-02-30`), so we round-trip through `Date` and require the parts to
 * survive normalization unchanged.
 */
export const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [y, m, d] = value.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return (
      dt.getUTCFullYear() === y &&
      dt.getUTCMonth() === m - 1 &&
      dt.getUTCDate() === d
    );
  }, "Invalid calendar date");

/** Returns true when `id` is a well-formed UUID. */
export function isUuid(id: string): boolean {
  return z.string().uuid().safeParse(id).success;
}
