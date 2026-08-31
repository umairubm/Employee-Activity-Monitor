---
name: Activity batch URL validation
description: Prevents malformed browser address-bar values from permanently blocking activity uploads.
---

Validate every captured browser URL, including already-schemed values, and sanitize URL fields again before each activity upload attempt. Preserve the activity segment when removing an invalid URL. Failed batches must remain queued rather than being discarded.

**Why:** one malformed browser accessibility value can make server validation reject the whole batch. Retrying the unchanged URL blocks every later segment, while dropping rejected batches causes silent activity loss.

**How to apply:** permit only bounded HTTP(S) URLs with a valid hostname and port and no whitespace/control characters. Build a sanitized send copy, but retain original queued records on any upload failure.