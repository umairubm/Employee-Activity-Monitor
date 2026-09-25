# Agent Screenshot State and Scheduling Fixes

This plan addresses the two architectural flaws in the Linux agent's screenshot lifecycle management:
1. The failure to restart Wayland capture if the subprocess exits or the portal session dies.
2. The eager advancement of the screenshot interval before confirming capture success, which delays retries for up to 10 minutes.

## Proposed Changes

### 1. `agent/screenshot.py` (State Machine)
- Introduce a `ScreencastState` enum (`STOPPED`, `STARTING`, `READY`, `FAILED`, `USER_STOPPED`).
- `WaylandScreencastManager` will initialize in `STOPPED`.
- Calling `start()` moves state to `STARTING`.
- Receiving the first valid MJPEG frame moves state to `READY`.
- A portal `Closed` signal sets state to `USER_STOPPED`.
- An unexpected subprocess exit sets state to `FAILED`.
- The `capture_webp_bytes()` function will read this state. If the state is `STARTING`, it will raise a specific `CaptureNotReadyError`.

### 2. `agent/agent.py` (Screenshot Scheduling & Recovery)
- Refactor `_maybe_screenshot()` to decouple the scheduled tick from the actual capture success.
- If capture succeeds, advance `_last_screenshot` and reset `_next_screenshot_gap` to the standard configured interval (e.g., 5-10 minutes).
- If capture raises `CaptureNotReadyError`, back off slightly (e.g. 5 seconds) without advancing the full interval, allowing the asynchronous startup to complete.
- If capture fails otherwise, implement a bounded exponential backoff (e.g., 5s -> 10s -> 20s -> max 60s) for retrying.
- In `_worker()`, check the screencast state:
  - If `FAILED`, automatically trigger a restart (`screenshot_mod.start_wayland_screencast()`) to recover from transient crashes.
  - If `USER_STOPPED`, do **not** restart the screencast. We will wait for the user to explicitly toggle the "Pause monitoring" / "Resume monitoring" button in the tray to re-trigger the edge transition (`not was_active` -> `is_active`).

## User Review Required

Does requiring the user to explicitly click "Resume monitoring" from the tray icon after revoking portal permissions align with your expected UX? Or would you prefer the agent to automatically pause itself (changing its tray icon to gray) so the user has visual feedback that tracking stopped?
