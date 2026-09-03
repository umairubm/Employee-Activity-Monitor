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
  segmentId: z.string().uuid().optional(), // Optional for legacy compat
  sequenceNamespace: z.string().optional(),
  sequence: z.number().int().nonnegative().optional(),
  processName: z.string().min(1),
  windowTitle: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date(),
  elapsedMilliseconds: z.number().int().nonnegative().optional(),
  engagementState: z.enum(["active", "passive", "idle"]).optional(),
  sessionState: z.enum(["unlocked", "locked", "suspended", "monitoring_paused"]).optional(),
  connectivityState: z.enum(["online", "offline", "unknown"]).optional(),
  transitionReason: z.string().optional(),
  policyVersion: z.string().optional(),
  
  // Legacy fields for backward compatibility during rollout
  durationSeconds: z.number().int().nonnegative().optional(),
  idleSeconds: z.number().int().nonnegative().optional(),
}).refine(data => data.endedAt >= data.startedAt, {
  message: "endedAt must be after or equal to startedAt",
  path: ["endedAt"]
});

export const ActivityBody = z.object({
  batchId: z.string().uuid().optional(), // Make optional for legacy compat
  logs: z.array(ActivityLogItem).min(1).max(500),
  hardwareChanges: z.record(z.string(), z.any()).optional(),
});
export type ActivityBody = z.infer<typeof ActivityBody>;

export const ScreenshotBody = z.object({
  storageKey: z.string().min(1),
  capturedAt: z.coerce.date(),
  fileSizeBytes: z.number().int().nonnegative().default(0),
});
export type ScreenshotBody = z.infer<typeof ScreenshotBody>;

export const CommandAckBody = z.object({
  commandId: z.string().uuid(),
  status: z.enum(["acknowledged", "downloading", "installing", "completed", "failed"]),
  message: z.string().optional(),
});
export type CommandAckBody = z.infer<typeof CommandAckBody>;
