---
name: Device remote management (timed lock, unlock, password reset, restart/shutdown, USB, metrics)
description: How the remote device command feature works end-to-end and the non-obvious constraints that keep it correct/secure.
---

# Remote device management pipeline

Admin issues commands from Device Details → `POST /api/devices/:id/commands`; agents pull them on the `/api/sync/heartbeat` poll and ack via `/api/sync/commands/ack`.

## Timed lock is enforced by RE-LOCKING, not a single OS action
**Rule:** a one-shot OS lock is NOT enough — the user can just unlock and re-login. The duration guarantee is implemented as: server tracks `devices.isLocked` + `locked_until`; heartbeat auto-expires the lock (`isLocked=false, lockedUntil=null`) once `locked_until` passes; the agent RE-LOCKS the screen every poll cycle while the heartbeat response says `isLocked=true`, and stops when it flips false. `unlock_screen` clears the enforced-lock state immediately.
**Why:** without per-poll re-locking, "Lock for 30 min" / timed sign-out is cosmetic. Both Python (`agent/agent.py`) and Node (`agent-node/tracker-client.mjs`) agents must keep this in lockstep.
**How to apply:** never "fix" the agent to lock only once on the command; the enforcement loop is the feature. Lock duration lives server-side only (agent trusts heartbeat `isLocked`).

## Password reset must avoid argv exposure
**Rule:** never pass a new OS password as a command-line arg (`net user user pass`) — it's world-readable via tasklist/WMI/`ps`. Pass it through the child process's ENV to a PowerShell `Set-LocalUser ... ConvertTo-SecureString $env:VAR`. Never log it; never echo the payload back.
**Why:** local users could harvest the admin-set password from process argv.
**How to apply:** the command payload still stores the password in the DB (agent needs it) but the POST response AND `GET /commands` history redact `reset_password` payloads to null. Keep both redaction points.

## Command ack carries an optional `message`
Failed acks may include a short `message` (e.g. "unsupported on macOS"); the server stores it in `device_commands.cancel_reason` so admins see why a command failed. Not for sensitive data.

## Schema reaches prod via drizzle-kit push, not migration files
This repo uses `pnpm --filter @workspace/db run push` (no migration files). New columns `devices.locked_until/usb_block_enabled/metrics/metrics_at` and the expanded `command_type` enum (`unlock_screen/reset_password/restart/shutdown/set_usb_block`) must be pushed to PROD at publish time or the new routes error.
