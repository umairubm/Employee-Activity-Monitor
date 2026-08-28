/**
 * Remote-command runner for the Node desktop agent.
 *
 * Extracted from tracker-client.mjs with all side effects injected so the
 * command lifecycle contract can be unit-tested with mocked HTTP and OS calls
 * (see test/command-runner.test.mjs). The contract mirrors the Python agent:
 *
 *   1. Validate the delivered command (string id + commandType) before acting.
 *   2. Never execute the same command twice in one session, even if the server
 *      redelivers it after a lost acknowledgement.
 *   3. The "acknowledged" ack MUST succeed before any destructive OS action.
 *      If it fails, nothing runs; the command stays pending server-side and is
 *      retried on a later heartbeat.
 *   4. Restart/shutdown are SCHEDULED with a grace delay, verified, and only
 *      then acked completed/failed — so the truthful result reaches the server
 *      before the machine goes down.
 *   5. Failures and unsupported actions ack "failed" with a safe, readable
 *      reason. Password values never appear in messages or logs.
 */

const COMMAND_ACTION_LABELS = {
  lock_screen: "lock your screen",
  logout_user: "sign you out",
  restart: "restart this computer",
  shutdown: "shut down this computer",
  reset_password: "reset your account password",
  update_agent: "update this agent",
};

// Command payloads arrive as a JSON *string* (or null). Parse defensively.
export function parseCommandPayload(payload) {
  if (payload == null) return null;
  if (typeof payload === "object") return payload;
  if (typeof payload === "string" && payload.trim()) {
    try {
      const parsed = JSON.parse(payload);
      return typeof parsed === "object" && parsed !== null ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

const safeMessage = (value, fallback) => {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, 200);
};

/**
 * @param {object} deps
 * @param {(id: string, status: string, message?: string|null) => Promise<void>} deps.ackCommand
 *   Must THROW when the server did not record the status.
 * @param {(commandId: string) => Promise<{downloadUrl?: string, fileName?: string}>} deps.fetchDownloadUrl
 * @param {(title: string, message: string) => Promise<void>} deps.showNotice
 * @param {(ms: number) => Promise<void>} deps.sleep
 * @param {(type: "restart"|"shutdown") => Promise<boolean>} deps.powerCommand
 *   Schedules the OS action with a grace delay; resolves true only if the OS accepted it.
 * @param {(type: "restart"|"shutdown") => Promise<boolean>} [deps.cancelPowerCommand]
 *   Cancels a recently scheduled OS power action when supported.
 * @param {() => Promise<boolean>} deps.logoutUser
 * @param {() => Promise<boolean>} deps.lockScreenOs
 * @param {(newPassword: string) => Promise<{ok: boolean, message?: string|null}>} deps.resetPassword
 * @param {(enabled: boolean) => Promise<boolean>} deps.setUsbBlock
 * @param {(url: string, fileName: string) => Promise<string>} deps.downloadInstaller
 * @param {(installerPath: string) => Promise<void>} deps.launchInstaller
 * @param {(archivePath: string, targetVersion: string) => Promise<void>} [deps.applyMacUpdate]
 * @param {(path: string) => void} deps.removeFile
 * @param {() => void} deps.exitProcess
 * @param {boolean} deps.isWin
 * @param {boolean} deps.isMac
 * @param {{isLocked?: boolean, lockedUntil?: string|null}} deps.clientState
 * @param {{usbBlockEnabled?: boolean}} deps.configState
 * @param {{get: (id: string) => {status: string, message?: string|null}|null, set: (id: string, result: {status: string, message: string|null}) => void}} [deps.resultStore]
 *   DURABLE (on-disk) journal of executed command results. Written BEFORE the
 *   final ack so that a lost ack response — even one racing a shutdown — can
 *   never cause the redelivered command to execute a second time after the
 *   agent restarts: the recorded result is re-acked instead.
 * @param {(...args: unknown[]) => void} [deps.warn]
 */
export function createCommandRunner(deps) {
  const warn = deps.warn ?? ((...args) => console.error(...args));
  const handledCommandIds = new Set();

  async function ackFinal(id, ok, failMessage) {
    const status = ok ? "completed" : "failed";
    const message = ok ? null : failMessage;
    // Journal BEFORE acking — see resultStore docs above.
    try {
      deps.resultStore?.set(id, { status, message });
    } catch (e) {
      warn("Could not persist command result:", e.message);
    }
    try {
      await deps.ackCommand(id, status, message);
    } catch (e) {
      // Best-effort: the journal + redelivery guard prevent a re-run; the
      // redelivered command will re-ack this recorded result.
      warn("Could not report command result:", e.message);
    }
  }

  async function runUpdate(cmd) {
    let installerPath = null;
    try {
      const payload = parseCommandPayload(cmd.payload);
      const version = payload && payload.version;
      let fileName = payload && payload.fileName;
      if (!version || !fileName) throw new Error("missing update payload fields");

      const release = await deps.fetchDownloadUrl(cmd.id);
      const downloadUrl = String(release.downloadUrl || "");
      fileName = String(release.fileName || fileName);
      const url = new URL(downloadUrl);
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("unsupported download URL");
      }
      const isMacRelease =
        release.platform === "macos" &&
        fileName.toLowerCase().endsWith(".zip");
      if (deps.isMac && isMacRelease) {
        if (typeof deps.applyMacUpdate !== "function") {
          throw new Error(
            "macOS updates require the packaged WorkforceAgent app; this agent installation cannot self-update",
          );
        }
        await deps.ackCommand(cmd.id, "downloading");
        installerPath = await deps.downloadInstaller(downloadUrl, fileName);
        await deps.ackCommand(cmd.id, "installing");
        await deps.applyMacUpdate(installerPath, version);
        deps.exitProcess();
        return;
      }
      if (!deps.isWin || !fileName.toLowerCase().endsWith(".exe")) {
        throw new Error("unsupported update installer for this OS");
      }

      await deps.ackCommand(cmd.id, "downloading");
      installerPath = await deps.downloadInstaller(downloadUrl, fileName);
      await deps.ackCommand(cmd.id, "installing");
      await deps.launchInstaller(installerPath);
      // The installer replaces this agent; the first heartbeat from the new
      // build reporting the new version is the authoritative completion signal.
      deps.exitProcess();
    } catch (e) {
      if (installerPath) {
        try {
          deps.removeFile(installerPath);
        } catch {
          /* ignore */
        }
      }
      const message = safeMessage(e && e.message, "update_agent failed");
      try {
        deps.resultStore?.set(cmd.id, { status: "failed", message });
      } catch {
        /* best effort */
      }
      try {
        await deps.ackCommand(cmd.id, "failed", message);
      } catch (ackErr) {
        warn("Could not report update failure:", ackErr.message);
      }
    }
  }

  async function cancelPowerCommand(cancellation) {
    const type = cancellation && cancellation.commandType;
    if (
      !cancellation ||
      typeof cancellation.id !== "string" ||
      (type !== "restart" && type !== "shutdown")
    ) {
      return false;
    }
    if (typeof deps.cancelPowerCommand !== "function") return false;
    try {
      return await deps.cancelPowerCommand(type);
    } catch (e) {
      warn("Could not cancel scheduled power action:", e.message);
      return false;
    }
  }

  async function executeCommand(cmd) {
    const id = cmd && typeof cmd.id === "string" ? cmd.id : "";
    const type = cmd && typeof cmd.commandType === "string" ? cmd.commandType : "";
    if (!id || !type) {
      warn("Ignoring malformed command delivery");
      return;
    }
    // Redelivery guard: a heartbeat may redeliver a command whose ack was lost
    // in transit; destructive actions must never run twice.
    if (handledCommandIds.has(id)) return;
    handledCommandIds.add(id);

    // Cross-restart guard: if this command already EXECUTED (possibly in a
    // previous session) but its final ack was lost, re-send the recorded
    // result — never run the action again.
    const prior = deps.resultStore?.get(id);
    if (prior) {
      try {
        await deps.ackCommand(id, prior.status, prior.message ?? null);
      } catch (e) {
        handledCommandIds.delete(id); // retriable on the next redelivery
        warn("Could not re-ack recorded command result:", e.message);
      }
      return;
    }

    // unlock_screen and set_usb_block are silent (no user-facing notice).
    if (type in COMMAND_ACTION_LABELS) {
      const reasonText = cmd.reason ? ` Reason: ${cmd.reason}` : "";
      await deps.showNotice(
        "Administrator action",
        `IT is about to ${COMMAND_ACTION_LABELS[type]}.${reasonText}`,
      );
    }

    // The acknowledgement must succeed BEFORE any OS action. On failure the
    // command stays pending server-side; allow this id to be retried when the
    // server redelivers it.
    try {
      await deps.ackCommand(id, "acknowledged");
    } catch (e) {
      handledCommandIds.delete(id);
      warn("Could not acknowledge command; not executing:", e.message);
      return;
    }

    if (type === "update_agent") {
      await runUpdate(cmd);
      return;
    }

    if (type === "restart" || type === "shutdown") {
      // Give the user a few seconds to see the notice, then SCHEDULE the power
      // action (with an OS-side grace delay), verify it was accepted, and
      // report the truthful result while the machine is still up.
      await deps.sleep(4000);
      let ok = false;
      try {
        ok = await deps.powerCommand(type);
      } catch {
        ok = false;
      }
      await ackFinal(id, ok, `could not schedule ${type} on this OS`);
      return;
    }

    let ok = true;
    let failMessage = null;
    try {
      if (type === "lock_screen") {
        ok = await deps.lockScreenOs();
        if (!ok) failMessage = "lock_screen is not supported on this OS";
      } else if (type === "logout_user") {
        await deps.sleep(4000);
        ok = await deps.logoutUser();
        if (!ok) failMessage = "logout_user is not supported on this OS";
      } else if (type === "unlock_screen") {
        // No OS action — clear local lock-enforcement state.
        deps.clientState.isLocked = false;
        deps.clientState.lockedUntil = null;
      } else if (type === "reset_password") {
        if (!deps.isWin) {
          ok = false;
          failMessage = `reset_password is unsupported on ${deps.isMac ? "macOS" : "Linux"}`;
        } else {
          const payload = parseCommandPayload(cmd.payload);
          const newPassword = payload && payload.newPassword;
          if (!newPassword) {
            ok = false;
            failMessage = "No newPassword provided in payload";
          } else {
            const r = await deps.resetPassword(newPassword);
            if (!r.ok) {
              ok = false;
              // ALWAYS generic: the OS-level error text is not trusted to
              // exclude the submitted password, so never forward it.
              failMessage = "password reset failed";
            }
          }
        }
      } else if (type === "set_usb_block") {
        if (!deps.isWin) {
          ok = false;
          failMessage = `set_usb_block is unsupported on ${deps.isMac ? "macOS" : "Linux"}`;
        } else {
          const payload = parseCommandPayload(cmd.payload);
          const enabled = payload && payload.enabled === true;
          deps.configState.usbBlockEnabled = enabled;
          const applied = await deps.setUsbBlock(enabled);
          if (!applied) {
            ok = false;
            failMessage = "Failed to apply USB policy (admin rights required)";
          }
        }
      } else {
        ok = false;
        failMessage = `unsupported command type: ${type}`;
      }
    } catch (e) {
      ok = false;
      // Never leak sensitive payload data (a password) via the failure ack.
      failMessage =
        type === "reset_password"
          ? "password reset failed"
          : safeMessage(e && e.message, `${type} failed`);
      warn(`Command ${type} failed:`, failMessage);
    }

    await ackFinal(id, ok, failMessage);
  }

  return { executeCommand, cancelPowerCommand, handledCommandIds };
}
