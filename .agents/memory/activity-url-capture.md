---
name: Activity URL capture
description: How browser URLs enter activity logs and why some records do not have them
---

Activity URLs are optional metadata. Windows desktop agents read an accessible address-bar value through UI Automation, while macOS agents use browser AppleScript with an Accessibility UI fallback for Firefox. Both normalize a scheme-less web address to `https://` and omit non-web values; non-browser apps, unsupported platforms, and inaccessible address bars report no URL. The API and database must continue accepting activity without this field.

**Why:** Foreground window titles do not contain a reliable or safe URL, and historical activity rows were created before URL capture existed, so the dashboard cannot reconstruct links retroactively.

**How to apply:** Keep URL capture best-effort and transparent, validate/store only web URLs, render missing URLs as absent rather than inventing links, and distribute the updated desktop agent before expecting new records to contain URLs.