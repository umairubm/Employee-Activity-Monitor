/**
 * How long an admin-generated "forgot password" reset code stays valid.
 * Codes are single-use: redeemed or overwritten codes are invalidated.
 */
export const RESET_CODE_TTL_MS = 30 * 60 * 1000; // 30 minutes
