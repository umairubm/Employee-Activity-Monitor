import { z } from "zod/v4";

export const EnrollBody = z.object({
  token: z.string().min(1),
  hardwareHash: z.string().min(1),
  systemName: z.string().min(1),
  osType: z.enum(["windows", "macos", "linux"]),
  agentVersion: z.string().optional(),
  // Transparency gate: the agent must report that the user acknowledged the
  // first-run consent dialog, and who acknowledged it.
  consentAcknowledged: z.literal(true),
  consentName: z.string().min(1),
});
export type EnrollBody = z.infer<typeof EnrollBody>;

export const HeartbeatBody = z.object({
  agentVersion: z.string().optional(),
});
export type HeartbeatBody = z.infer<typeof HeartbeatBody>;

export const ActivityLogItem = z.object({
  processName: z.string().min(1),
  windowTitle: z.string().optional(),
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date(),
  durationSeconds: z.number().int().nonnegative(),
  idleSeconds: z.number().int().nonnegative().optional(),
});

/**
 * Optional device hardware/system inventory snapshot. The agent decides the
 * exact keys; values are coerced to a flat record. Hardware-identity fields are
 * diffed for change alerts (see lib/systemInfo); volatile fields (IP, free
 * space) are stored but never alerted on.
 */
export const SystemInfo = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);
export type SystemInfo = z.infer<typeof SystemInfo>;

export const ActivityBody = z.object({
  logs: z.array(ActivityLogItem).min(1).max(500),
  systemInfo: SystemInfo.optional(),
});
export type ActivityBody = z.infer<typeof ActivityBody>;

/**
 * Screenshot uploads now send the raw image bytes as the request body (see
 * routes/sync.ts). The only metadata the agent supplies is the capture time,
 * passed in the `x-captured-at` header; everything else (size, content type,
 * hash) is derived server-side from the bytes.
 */
export const ScreenshotMeta = z.object({
  capturedAt: z.coerce.date(),
});
export type ScreenshotMeta = z.infer<typeof ScreenshotMeta>;

export const CommandAckBody = z.object({
  commandId: z.string().uuid(),
  status: z.enum(["acknowledged", "completed", "failed"]),
});
export type CommandAckBody = z.infer<typeof CommandAckBody>;
