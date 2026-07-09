import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Global (single-row) storage credential settings, editable by a Super User
 * from the dashboard's Storage page.
 *
 * Why the DB and not env vars: the operator may not have permission to manage
 * Replit Secrets, and DB-stored credentials survive redeploys and apply to
 * dev/prod independently. The app secret and refresh token are encrypted at
 * rest with AES-256-GCM keyed off SESSION_SECRET (see api-server
 * lib/settingsCrypto.ts); the app key is a public OAuth client id.
 *
 * Precedence in the api-server: DB credentials (when complete) override the
 * DROPBOX_* env vars.
 */
export const storageSettingsTable = pgTable("storage_settings", {
  /** Fixed single-row id ("global"). */
  id: text("id").primaryKey(),
  dropboxAppKey: text("dropbox_app_key"),
  /** AES-256-GCM ciphertext (iv:tag:data, base64). */
  dropboxAppSecretEnc: text("dropbox_app_secret_enc"),
  /** AES-256-GCM ciphertext (iv:tag:data, base64). */
  dropboxRefreshTokenEnc: text("dropbox_refresh_token_enc"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
