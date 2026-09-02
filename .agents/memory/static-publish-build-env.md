---
name: Static publish build environment
description: Build-time environment variables for static Vite artifacts
---

Static artifact production builds should declare every environment variable required while loading the Vite configuration; runtime service environment blocks are not a reliable source during the static build phase.

**Why:** A dashboard can run correctly in development and remain live in production while a republish fails before creating a build when Vite requires values such as `PORT` or `BASE_PATH` that the production build command did not receive.

**How to apply:** When a static Vite artifact validates required configuration at module load, put those values in the artifact's production build environment, then verify the exact production build command locally before asking the user to republish.