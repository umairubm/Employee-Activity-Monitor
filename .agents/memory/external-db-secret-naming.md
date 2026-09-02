---
name: External database secret naming
description: Replit publishing behavior for external PostgreSQL connection strings
---

When a project uses an external PostgreSQL database, its connection string must not be stored under Replit's reserved `DATABASE_URL` name. Use a different secret name and add that name to production app secrets.

**Why:** Replit's publishing checks interpret `DATABASE_URL` as the managed database variable and can block publishing when its value points to an external database, even while the app runs correctly.

**How to apply:** Rename the external connection secret in the workspace and production settings, update runtime and migration code to use the new name, and verify the API starts after restarting with the renamed secret.