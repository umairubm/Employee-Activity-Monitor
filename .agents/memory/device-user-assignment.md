---
name: Device-to-user assignment semantics
description: Product rules for linking replacement or additional laptops to an existing company user.
---

**Rule:** Treat “merge a new laptop with an existing user” as device reassignment, not record migration. A user may own multiple devices; assigning one changes only that device’s user link and preserves its full device-owned history.

**Why:** Laptop replacement should not create a duplicate person, delete the old laptop, move historical telemetry between devices, or alter the user’s other assigned laptops.

**How to apply:** Keep activity, screenshots, commands, alerts, enrollment metadata, group, and region attached to their original device. Validate the selected user belongs to the same tenant and enforce manager device scope on every assignment mutation.