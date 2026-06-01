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

export const ActivityBody = z.object({
  logs: z.array(ActivityLogItem).min(1).max(500),
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
  status: z.enum(["acknowledged", "completed", "failed"]),
});
export type CommandAckBody = z.infer<typeof CommandAckBody>;
