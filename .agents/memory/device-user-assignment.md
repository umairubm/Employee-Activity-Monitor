---
name: Device replacement merge semantics
description: Product rules for treating a replacement laptop as the continuation of a predecessor device.
---

**Rule:** Treat laptop replacement as an atomic device-to-device merge. The new laptop remains the active device; the predecessor remains as an audit/provenance row, leaves the active fleet, and cannot authenticate or send telemetry. Move device-owned history where compatible, preserve the replacement identity/settings, and never merge, create, or delete user records.

**Why:** A person changing laptops should retain one continuous operational history without combining user accounts or losing the old hardware record. Different assigned users must be rejected rather than silently combined.

**How to apply:** Require explicit merge confirmation, tenant and manager scope checks for both devices, and idempotent conflict handling for screenshots, daily summaries, and attendance overrides. Keep existing replacement-specific attendance settings canonical; only move the predecessor override when the replacement has none.