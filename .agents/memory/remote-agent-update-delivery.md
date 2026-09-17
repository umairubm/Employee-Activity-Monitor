---
name: Remote agent update delivery
description: Durable rules for safely delivering self-updating desktop agent installers.
---

Uploaded agent installers must be tenant-owned, resolved through the authenticated device command pipeline, and signed close to delivery rather than when an admin creates the rollout. Update progress is monotonic: the server only treats a version heartbeat as success after that device has reported the update is installing.

**Why:** Devices can remain offline longer than an object-storage URL's TTL, and a device that already reports the target version must not make a newly queued command appear completed before it was delivered.

**How to apply:** Keep release object paths tenant-prefixed and validate the prefix against the authenticated company. Store a release reference in each command, let the device resolve a fresh download URL with its device credentials, and restrict the agent UI/source formats to platforms the installed agents can actually replace.

A release has a `kind`: full installer (.exe, agent runs it) or code patch (.zip, agent extracts over its files and restarts). Delivery is one pipeline; only the agent-side apply step differs. `kind` MUST travel end-to-end — persisted on the release, embedded in the update command payload, AND returned by the download-url resolver — so the device knows how to apply it. **Why:** the resolver defaults a missing kind to installer, so a patch that loses its kind anywhere gets run as an .exe. There are TWO command-issuing paths (the bulk `/devices/agent-updates` rollout AND the generic `/devices/:id/commands` update_agent) — both must carry kind and enforce filename-extension matches kind (.exe vs .zip), or one path silently emits kind-less commands.

macOS remote updates are Developer ID signed/notarized `.app.zip` installers. Trust is anchored to the currently installed app's Team ID; require the expected bundle ID, exact target version, fixed executable name, strict top-level layout, `codesign`, and Gatekeeper assessment before replacing anything. Keep the old app as a rollback backup until the replacement's first successful heartbeat, and ensure remote shutdown stops both worker and tray event loops so the detached swap helper can observe the old PID exit.

**Why:** a syntactically valid signature alone can belong to another developer; accepting a different bundle version strands completion; deleting the backup after `open` succeeds loses recovery if Gatekeeper blocks or the app crashes; stopping only the worker leaves the tray process alive and prevents every swap.

**How to apply:** platform, kind, and version must travel through release→command→download resolver. macOS archives target only macOS devices. Exact suffixed/prerelease heartbeats complete exact targets, while numeric versions may still supersede older numeric update commands.

## Windows update trust and migration

Silent upgrades must retain the normal product identity and original enrollment consent, not replace the agent with a disguised monitoring product. Do not reduce Defender or firewall protection to obtain silent behavior.

**Why:** The intended product behavior is visible initial installation followed by authorized unattended maintenance, not Microsoft impersonation or security bypass. Installer flags cannot bypass UAC, enterprise policy, or establish publisher trust.

**How to apply:** Keep Windows signing as a prerequisite for trusted unattended releases. Legacy unsigned agents require a one-time manual signed bootstrap; do not add an unsigned fallback or treat a generic signed Python/Node interpreter as the vendor's trust anchor. A successful source push is not proof that Windows installers were built, signed, published, or installed.