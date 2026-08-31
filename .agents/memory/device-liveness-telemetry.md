---
name: Device liveness from telemetry
description: Defines which authenticated agent communications prove a device is online.
---

Any successfully accepted, authenticated agent telemetry counts as proof of liveness. Activity and screenshot uploads must refresh the device's last-seen timestamp, including valid deduplicated screenshot retries; rejected or malformed requests must not.

**Why:** heartbeat, activity, and screenshot requests are independent. A heartbeat can fail while current work continues uploading, which otherwise makes an actively working device appear offline.

**How to apply:** when adding a new authenticated agent telemetry endpoint, refresh liveness only after its payload has been validated and accepted. Keep the update tenant-scoped as well as device-scoped.