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
  // Device wall-clock offset (minutes) relative to the UTC instants the agent
  // reports, e.g. 330 for IST. Lets the dashboard render times as the device
  // user saw them. Bounded to ±  24h to reject garbage.
  tzOffsetMinutes: z.number().int().min(-1440).max(1440).optional(),
  // Live utilization snapshot captured just before the heartbeat. Optional so
  // older agents keep working; stored on the device row for the dashboard's
  // System Metrics card.
  metrics: z
    .object({
      cpuPercent: z.number().min(0).max(100).nullable().optional(),
      ramPercent: z.number().min(0).max(100).nullable().optional(),
      diskFreeBytes: z.number().nonnegative().nullable().optional(),
      diskTotalBytes: z.number().nonnegative().nullable().optional(),
    })
    .optional(),
});
export type HeartbeatBody = z.infer<typeof HeartbeatBody>;

export const ActivityLogItem = z.object({
  segmentId: z.string().uuid().optional(),
  sequenceNamespace: z.string().min(1).optional(),
  sequence: z.number().int().nonnegative().optional(),
  processName: z.string().min(1),
  windowTitle: z.string().nullable().optional(),
  // Optional URL metadata must never poison a durable activity batch. The
  // route keeps only valid HTTP(S) URLs and stores all other values as null.
  url: z.string().max(2048).nullable().optional(),
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date(),
  elapsedMilliseconds: z.number().int().nonnegative().optional(),
  engagementState: z.enum(["active", "passive", "idle"]).optional(),
  sessionState: z
    .enum(["unlocked", "locked", "suspended", "monitoring_paused"])
    .optional(),
  connectivityState: z.enum(["online", "offline", "unknown"]).optional(),
  transitionReason: z.string().max(200).optional(),
  policyVersion: z.string().max(100).optional(),
  durationSeconds: z.number().int().nonnegative().optional(),
  idleSeconds: z.number().int().nonnegative().optional(),
}).refine(
  (log) =>
    log.endedAt >= log.startedAt &&
    (log.durationSeconds !== undefined ||
      log.elapsedMilliseconds !== undefined),
  {
    message:
      "endedAt must not precede startedAt and a duration value is required",
  },
);

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
  batchId: z.string().uuid().optional(),
  logs: z.array(ActivityLogItem).min(1).max(500),
  systemInfo: SystemInfo.optional(),
  // Interval agents may include extra/non-scalar hardware metadata. The route
  // retains only the scalar fields supported by devices.systemInfo.
  hardwareChanges: z.record(z.string(), z.unknown()).optional(),
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
  status: z.enum([
    "acknowledged",
    "downloading",
    "installing",
    "completed",
    "failed",
  ]),
  // Optional human-readable failure detail from the agent (e.g. "unsupported
  // on macOS"). Never contains sensitive payloads. Stored on the command row.
  message: z.string().max(1000).optional(),
});
export type CommandAckBody = z.infer<typeof CommandAckBody>;
