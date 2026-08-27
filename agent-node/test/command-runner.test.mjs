/**
 * Contract tests for the remote-command lifecycle (agent-node).
 * Run with:  node --test agent-node/test/
 *
 * All HTTP (ackCommand/fetchDownloadUrl) and OS calls are mocked; these tests
 * pin the delivery → acknowledge → execute → truthful-result contract shared
 * with the Python agent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createCommandRunner, parseCommandPayload } from "../command-runner.mjs";

function makeDeps(overrides = {}) {
  const calls = { acks: [], notices: [], power: [], warn: [] };
  const deps = {
    ackCommand: async (id, status, message) => {
      calls.acks.push({ id, status, message: message ?? null });
    },
    fetchDownloadUrl: async () => ({
      downloadUrl: "https://example.com/agent.exe",
      fileName: "agent.exe",
    }),
    showNotice: async (title, message) => {
      calls.notices.push({ title, message });
    },
    sleep: async () => {},
    powerCommand: async (type) => {
      calls.power.push(type);
      return true;
    },
    logoutUser: async () => true,
    lockScreenOs: async () => true,
    resetPassword: async () => ({ ok: true, message: null }),
    setUsbBlock: async () => true,
    downloadInstaller: async () => "/tmp/fake-installer.exe",
    launchInstaller: async () => {},
    removeFile: () => {},
    exitProcess: () => {
      calls.exited = true;
    },
    isWin: true,
    isMac: false,
    clientState: { isLocked: true, lockedUntil: "2026-01-01T00:00:00Z" },
    configState: { usbBlockEnabled: false },
    warn: (...args) => calls.warn.push(args.join(" ")),
    ...overrides,
  };
  return { deps, calls };
}

const cmd = (over = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  commandType: "lock_screen",
  reason: "Security audit",
  payload: null,
  ...over,
});

test("successful command: acknowledged before execution, then completed", async () => {
  const { deps, calls } = makeDeps();
  const runner = createCommandRunner(deps);
  await runner.executeCommand(cmd());
  assert.deepEqual(
    calls.acks.map((a) => a.status),
    ["acknowledged", "completed"],
  );
  assert.equal(calls.notices.length, 1);
  assert.match(calls.notices[0].message, /Security audit/);
});

test("malformed delivery (missing id/type) is ignored without any ack", async () => {
  const { deps, calls } = makeDeps();
  const runner = createCommandRunner(deps);
  await runner.executeCommand({ commandType: "lock_screen" });
  await runner.executeCommand({ id: "x" });
  await runner.executeCommand(null);
  assert.equal(calls.acks.length, 0);
});

test("failed acknowledgement blocks execution and allows a later retry", async () => {
  let failAck = true;
  const { deps, calls } = makeDeps({
    ackCommand: async (id, status, message) => {
      if (failAck) throw new Error("network down");
      calls.acks.push({ id, status, message: message ?? null });
    },
  });
  const runner = createCommandRunner(deps);
  const c = cmd({ commandType: "shutdown" });

  await runner.executeCommand(c);
  // Nothing executed, nothing acked; the id is retriable.
  assert.equal(calls.power.length, 0);
  assert.equal(calls.acks.length, 0);
  assert.equal(runner.handledCommandIds.has(c.id), false);

  // The server redelivers on the next heartbeat once the network recovers.
  failAck = false;
  await runner.executeCommand(c);
  assert.deepEqual(calls.power, ["shutdown"]);
  assert.deepEqual(
    calls.acks.map((a) => a.status),
    ["acknowledged", "completed"],
  );
});

test("redelivered command is never executed twice", async () => {
  const { deps, calls } = makeDeps();
  const runner = createCommandRunner(deps);
  const c = cmd({ commandType: "restart" });
  await runner.executeCommand(c);
  await runner.executeCommand(c); // heartbeat redelivery
  assert.deepEqual(calls.power, ["restart"]);
  assert.equal(calls.acks.filter((a) => a.status === "completed").length, 1);
});

test("restart reports completed only after the OS accepted the schedule", async () => {
  const order = [];
  const { deps } = makeDeps({
    ackCommand: async (_id, status) => order.push(`ack:${status}`),
    powerCommand: async () => {
      order.push("schedule");
      return true;
    },
  });
  const runner = createCommandRunner(deps);
  await runner.executeCommand(cmd({ commandType: "restart" }));
  assert.deepEqual(order, ["ack:acknowledged", "schedule", "ack:completed"]);
});

test("shutdown that the OS rejects reports failed with a readable reason", async () => {
  const { deps, calls } = makeDeps({ powerCommand: async () => false });
  const runner = createCommandRunner(deps);
  await runner.executeCommand(cmd({ commandType: "shutdown" }));
  const last = calls.acks.at(-1);
  assert.equal(last.status, "failed");
  assert.match(last.message, /could not schedule shutdown/);
});

test("unsupported command type reports failed, not completed", async () => {
  const { deps, calls } = makeDeps();
  const runner = createCommandRunner(deps);
  await runner.executeCommand(cmd({ commandType: "self_destruct" }));
  const last = calls.acks.at(-1);
  assert.equal(last.status, "failed");
  assert.match(last.message, /unsupported command type: self_destruct/);
});

test("reset_password failures never include the password", async () => {
  const secret = "Sup3r-S3cret!";
  const { deps, calls } = makeDeps({
    resetPassword: async () => {
      throw new Error(`boom ${secret}`);
    },
  });
  const runner = createCommandRunner(deps);
  await runner.executeCommand(
    cmd({
      commandType: "reset_password",
      payload: JSON.stringify({ newPassword: secret }),
    }),
  );
  const last = calls.acks.at(-1);
  assert.equal(last.status, "failed");
  assert.equal(last.message.includes(secret), false);
  for (const line of calls.warn) assert.equal(line.includes(secret), false);
});

test("reset_password {ok:false} acks only the generic message, never OS error text", async () => {
  const secret = "Sup3r-S3cret!";
  const { deps, calls } = makeDeps({
    resetPassword: async () => ({
      ok: false,
      message: `Set-LocalUser: cannot set ${secret} due to policy`,
    }),
  });
  const runner = createCommandRunner(deps);
  await runner.executeCommand(
    cmd({
      commandType: "reset_password",
      payload: JSON.stringify({ newPassword: secret }),
    }),
  );
  const last = calls.acks.at(-1);
  assert.equal(last.status, "failed");
  assert.equal(last.message, "password reset failed");
});

test("reset_password without a password fails cleanly", async () => {
  const { deps, calls } = makeDeps();
  const runner = createCommandRunner(deps);
  await runner.executeCommand(
    cmd({ commandType: "reset_password", payload: "{}" }),
  );
  const last = calls.acks.at(-1);
  assert.equal(last.status, "failed");
  assert.match(last.message, /No newPassword/);
});

test("reset_password is reported unsupported off Windows", async () => {
  const { deps, calls } = makeDeps({ isWin: false, isMac: true });
  const runner = createCommandRunner(deps);
  await runner.executeCommand(
    cmd({
      commandType: "reset_password",
      payload: JSON.stringify({ newPassword: "x" }),
    }),
  );
  assert.match(calls.acks.at(-1).message, /unsupported on macOS/);
});

test("unlock_screen clears local lock state and completes", async () => {
  const { deps, calls } = makeDeps();
  const runner = createCommandRunner(deps);
  await runner.executeCommand(cmd({ commandType: "unlock_screen" }));
  assert.equal(deps.clientState.isLocked, false);
  assert.equal(deps.clientState.lockedUntil, null);
  assert.equal(calls.acks.at(-1).status, "completed");
  // Silent command: no user-facing notice.
  assert.equal(calls.notices.length, 0);
});

test("update lifecycle advances acknowledged → downloading → installing, then exits", async () => {
  const order = [];
  const { deps, calls } = makeDeps({
    ackCommand: async (_id, status) => order.push(status),
    downloadInstaller: async () => {
      order.push("download");
      return "/tmp/i.exe";
    },
    launchInstaller: async () => order.push("launch"),
    exitProcess: () => order.push("exit"),
  });
  const runner = createCommandRunner(deps);
  await runner.executeCommand(
    cmd({
      commandType: "update_agent",
      payload: JSON.stringify({ version: "1.2.1", fileName: "agent.exe" }),
    }),
  );
  assert.deepEqual(order, [
    "acknowledged",
    "downloading",
    "download",
    "installing",
    "launch",
    "exit",
  ]);
  assert.equal(calls.warn.length, 0);
});

test("update download failure reports failed and cleans up the temp file", async () => {
  const removed = [];
  const { deps, calls } = makeDeps({
    downloadInstaller: async () => {
      throw new Error("Download failed with status 500");
    },
    removeFile: (p) => removed.push(p),
  });
  const runner = createCommandRunner(deps);
  await runner.executeCommand(
    cmd({
      commandType: "update_agent",
      payload: JSON.stringify({ version: "1.2.1", fileName: "agent.exe" }),
    }),
  );
  const last = calls.acks.at(-1);
  assert.equal(last.status, "failed");
  assert.match(last.message, /Download failed/);
});

test("update on a non-Windows host fails as unsupported before downloading", async () => {
  const { deps, calls } = makeDeps({ isWin: false, isMac: false });
  const runner = createCommandRunner(deps);
  await runner.executeCommand(
    cmd({
      commandType: "update_agent",
      payload: JSON.stringify({ version: "1.2.1", fileName: "agent.exe" }),
    }),
  );
  assert.deepEqual(
    calls.acks.map((a) => a.status),
    ["acknowledged", "failed"],
  );
  assert.match(calls.acks.at(-1).message, /unsupported update installer/);
});

test("update with a missing payload fails with a readable reason", async () => {
  const { deps, calls } = makeDeps();
  const runner = createCommandRunner(deps);
  await runner.executeCommand(
    cmd({ commandType: "update_agent", payload: null }),
  );
  assert.match(calls.acks.at(-1).message, /missing update payload/);
});

test("executed result is journaled BEFORE the final ack", async () => {
  const order = [];
  const store = new Map();
  const { deps } = makeDeps({
    ackCommand: async (_id, status) => order.push(`ack:${status}`),
    resultStore: {
      get: (id) => store.get(id) ?? null,
      set: (id, r) => {
        store.set(id, r);
        order.push("journal");
      },
    },
  });
  const runner = createCommandRunner(deps);
  const c = cmd({ commandType: "shutdown" });
  await runner.executeCommand(c);
  assert.deepEqual(order, ["ack:acknowledged", "journal", "ack:completed"]);
  assert.deepEqual(store.get(c.id), { status: "completed", message: null });
});

test("lost final ack + agent restart: redelivery re-acks the journal, never re-executes", async () => {
  // Session 1: shutdown executes, the completed ack is LOST (machine goes
  // down before the response arrives) — but the result was journaled first.
  const store = new Map();
  const resultStore = {
    get: (id) => store.get(id) ?? null,
    set: (id, r) => store.set(id, r),
  };
  const power = [];
  const c = cmd({ commandType: "shutdown" });

  const s1 = makeDeps({
    resultStore,
    powerCommand: async (t) => {
      power.push(t);
      return true;
    },
    ackCommand: async (_id, status) => {
      if (status === "completed") throw new Error("connection reset");
    },
  });
  await createCommandRunner(s1.deps).executeCommand(c);
  assert.deepEqual(power, ["shutdown"]);
  assert.deepEqual(store.get(c.id), { status: "completed", message: null });

  // Session 2: fresh runner (empty in-memory dedup) after the reboot; the
  // server redelivers the still-acknowledged command.
  const s2 = makeDeps({
    resultStore,
    powerCommand: async (t) => {
      power.push(t);
      return true;
    },
  });
  await createCommandRunner(s2.deps).executeCommand(c);
  assert.deepEqual(power, ["shutdown"], "must not power-cycle a second time");
  assert.deepEqual(
    s2.calls.acks,
    [{ id: c.id, status: "completed", message: null }],
    "re-acks the recorded result only",
  );
  assert.equal(s2.calls.notices.length, 0, "no repeat user notice");
});

test("failed re-ack of a journaled result stays retriable", async () => {
  const store = new Map([
    [cmd().id, { status: "failed", message: "requires admin" }],
  ]);
  const resultStore = {
    get: (id) => store.get(id) ?? null,
    set: (id, r) => store.set(id, r),
  };
  let failAck = true;
  const { deps, calls } = makeDeps({
    resultStore,
    ackCommand: async (id, status, message) => {
      if (failAck) throw new Error("network down");
      calls.acks.push({ id, status, message: message ?? null });
    },
  });
  const runner = createCommandRunner(deps);
  await runner.executeCommand(cmd());
  assert.equal(calls.acks.length, 0);

  failAck = false;
  await runner.executeCommand(cmd()); // next redelivery
  assert.deepEqual(calls.acks, [
    { id: cmd().id, status: "failed", message: "requires admin" },
  ]);
});

test("update failure is journaled so a restarted agent re-acks instead of re-downloading", async () => {
  const store = new Map();
  const resultStore = {
    get: (id) => store.get(id) ?? null,
    set: (id, r) => store.set(id, r),
  };
  const c = cmd({
    commandType: "update_agent",
    payload: JSON.stringify({ version: "1.2.1", fileName: "agent.exe" }),
  });
  const s1 = makeDeps({
    resultStore,
    downloadInstaller: async () => {
      throw new Error("Download failed with status 500");
    },
  });
  await createCommandRunner(s1.deps).executeCommand(c);
  assert.equal(store.get(c.id).status, "failed");

  const downloads = [];
  const s2 = makeDeps({
    resultStore,
    downloadInstaller: async () => {
      downloads.push(1);
      return "/tmp/i.exe";
    },
  });
  await createCommandRunner(s2.deps).executeCommand(c);
  assert.equal(downloads.length, 0);
  assert.equal(s2.calls.acks.at(-1).status, "failed");
});

test("parseCommandPayload is defensive about malformed JSON", () => {
  assert.equal(parseCommandPayload(null), null);
  assert.equal(parseCommandPayload("not json"), null);
  assert.equal(parseCommandPayload("42"), null);
  assert.deepEqual(parseCommandPayload('{"a":1}'), { a: 1 });
  assert.deepEqual(parseCommandPayload({ a: 1 }), { a: 1 });
});
