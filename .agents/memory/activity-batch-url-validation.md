---
name: Activity batch URL validation
description: Prevents malformed browser address-bar values from permanently blocking activity uploads.
---

Validate every captured browser URL, including already-schemed values, and sanitize URL fields again before each activity upload attempt. Preserve the activity segment when removing an invalid URL. Failed batches must remain queued rather than being discarded.

**Why:** one malformed browser accessibility value can make server validation reject the whole batch. Retrying the unchanged URL blocks every later segment, while dropping rejected batches causes silent activity loss.

**How to apply:** agents should permit only bounded HTTP(S) URLs with a valid hostname and port and no whitespace/control characters, using a sanitized send copy while retaining queued records on failure. The receiver must also treat unusable optional URLs as null rather than reject the full durable batch; client-side sanitation alone cannot repair already-queued rows.