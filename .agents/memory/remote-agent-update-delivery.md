---
name: Remote agent update delivery
description: Durable rules for safely delivering self-updating desktop agent installers.
---

Uploaded agent installers must be tenant-owned, resolved through the authenticated device command pipeline, and signed close to delivery rather than when an admin creates the rollout. Update progress is monotonic: the server only treats a version heartbeat as success after that device has reported the update is installing.

**Why:** Devices can remain offline longer than an object-storage URL's TTL, and a device that already reports the target version must not make a newly queued command appear completed before it was delivered.

**How to apply:** Keep release object paths tenant-prefixed and validate the prefix against the authenticated company. Store a release reference in each command, let the device resolve a fresh download URL with its device credentials, and restrict the agent UI/source formats to platforms the installed agents can actually replace.

A release has a `kind`: full installer (.exe, agent runs it) or code patch (.zip, agent extracts over its files and restarts). Delivery is one pipeline; only the agent-side apply step differs. `kind` MUST travel end-to-end — persisted on the release, embedded in the update command payload, AND returned by the download-url resolver — so the device knows how to apply it. **Why:** the resolver defaults a missing kind to installer, so a patch that loses its kind anywhere gets run as an .exe. There are TWO command-issuing paths (the bulk `/devices/agent-updates` rollout AND the generic `/devices/:id/commands` update_agent) — both must carry kind and enforce filename-extension matches kind (.exe vs .zip), or one path silently emits kind-less commands.