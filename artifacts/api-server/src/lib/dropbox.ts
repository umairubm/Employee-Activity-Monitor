import { logger } from "./logger";

/**
 * Dropbox storage for screenshot bytes.
 *
 * Screenshots are PRIVATE: they are uploaded into an app-scoped Dropbox folder
 * and only ever exposed through short-lived temporary links generated on
 * demand (see `getTemporaryLink`). No public/shared links are ever created.
 *
 * A fresh access token is fetched from the Replit connectors proxy on every
 * call — tokens expire, so they are never cached. This mirrors the GitHub
 * connector contract in `github.ts`. See the `integrations` skill.
 */

const RPC_BASE = "https://api.dropboxapi.com/2";
const CONTENT_BASE = "https://content.dropboxapi.com/2";

// Hard cap on any single Dropbox HTTP call. Without this, a hung connection
// could outlive the upload worker's row lease, letting another worker re-claim
// the same row (see screenshotUploadWorker LEASE_MS). A timeout aborts the
// request; the worker's retry/backoff handles the (retryable) failure.
const REQUEST_TIMEOUT_MS = 30_000;

/** Root folder under which all tenants' screenshots live. */
export const DROPBOX_ROOT = "/AgentImages";

class DropboxError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly summary?: string,
  ) {
    super(message);
    this.name = "DropboxError";
  }
}

/** True when Dropbox says the request was rate limited. */
function isRateLimited(status: number): boolean {
  return status === 429;
}

/**
 * Cache for tokens minted from a refresh token. Dropbox short-lived access
 * tokens live ~4h; we refresh a few minutes early. Not used for the static
 * `DROPBOX_ACCESS_TOKEN` or the connector path.
 */
let refreshedToken: { token: string; expiresAt: number } | null = null;

/**
 * Mint a fresh short-lived access token from a long-lived refresh token +
 * app key/secret. This is the durable manual path (tokens auto-renew).
 */
async function mintTokenFromRefreshToken(
  refreshToken: string,
  appKey: string,
  appSecret: string,
): Promise<string> {
  const now = Date.now();
  if (refreshedToken && refreshedToken.expiresAt > now + 60_000) {
    return refreshedToken.token;
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const basic = Buffer.from(`${appKey}:${appSecret}`).toString("base64");
  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Dropbox token refresh failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) {
    throw new Error("Dropbox token refresh returned no access_token");
  }
  refreshedToken = {
    token: data.access_token,
    expiresAt: now + (data.expires_in ?? 14400) * 1000,
  };
  return refreshedToken.token;
}

/**
 * Resolve a Dropbox access token. Precedence:
 *   1. DROPBOX_REFRESH_TOKEN (+ DROPBOX_APP_KEY / DROPBOX_APP_SECRET) — durable,
 *      auto-renewing manual token with full scopes. Preferred.
 *   2. DROPBOX_ACCESS_TOKEN — a static (short-lived) manual token; simplest for
 *      quick testing, expires in ~4h.
 *   3. The Replit Dropbox connector — note the managed connector currently only
 *      grants `files.metadata.read`, which is NOT enough to upload screenshots.
 *      A manual token (1 or 2) with `files.content.write`, `files.content.read`
 *      and `sharing.write` scopes is required for the screenshot pipeline.
 */
async function getAccessToken(): Promise<string> {
  const refreshToken = process.env.DROPBOX_REFRESH_TOKEN;
  const appKey = process.env.DROPBOX_APP_KEY;
  const appSecret = process.env.DROPBOX_APP_SECRET;
  if (refreshToken && appKey && appSecret) {
    return mintTokenFromRefreshToken(refreshToken, appKey, appSecret);
  }

  const staticToken = process.env.DROPBOX_ACCESS_TOKEN;
  if (staticToken) {
    return staticToken;
  }

  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;
  if (!hostname || !xReplitToken) {
    throw new Error("Dropbox connection is not available in this environment");
  }
  const res = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=dropbox`,
    {
      headers: { Accept: "application/json", X_REPLIT_TOKEN: xReplitToken },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    throw new Error(`Dropbox connector lookup failed (${res.status})`);
  }
  const data = (await res.json()) as {
    items?: Array<{
      settings?: {
        access_token?: string;
        oauth?: { credentials?: { access_token?: string } };
      };
    }>;
  };
  const settings = data.items?.[0]?.settings;
  const token =
    settings?.access_token ?? settings?.oauth?.credentials?.access_token;
  if (!token) {
    throw new Error("No Dropbox access token found on the connection");
  }
  return token;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Perform a Dropbox API call with a fresh token, retrying transient failures.
 *
 * - 401 (expired/rotated token): refetch the token once and retry immediately.
 * - 429 (rate limited): honour `Retry-After` (falling back to backoff) and retry.
 * - 5xx / network errors: exponential backoff.
 *
 * Retries are bounded so a persistently failing job surfaces its error to the
 * caller (the upload worker), which records it and schedules a later attempt.
 */
async function dropboxFetch(
  url: string,
  init: {
    headers?: Record<string, string>;
    body?: Buffer | string;
  },
  opts: { maxRetries?: number } = {},
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 4;
  let token = await getAccessToken();
  let refreshedToken = false;

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      await sleep(Math.min(1000 * 2 ** attempt, 15000));
      continue;
    }

    if (res.ok) return res;

    // Expired/rotated token — refetch once, then keep retrying normally.
    if (res.status === 401 && !refreshedToken) {
      refreshedToken = true;
      token = await getAccessToken();
      continue;
    }

    if (attempt >= maxRetries) {
      const summary = await res.text().catch(() => "");
      throw new DropboxError(
        `Dropbox request failed (${res.status})`,
        res.status,
        summary,
      );
    }

    if (isRateLimited(res.status)) {
      const retryAfter = Number(res.headers.get("Retry-After"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(1000 * 2 ** attempt, 15000);
      await sleep(waitMs);
      continue;
    }

    // 5xx and other transient statuses: backoff and retry.
    if (res.status >= 500) {
      await sleep(Math.min(1000 * 2 ** attempt, 15000));
      continue;
    }

    // 4xx (other than 401/429): not retryable.
    const summary = await res.text().catch(() => "");
    throw new DropboxError(
      `Dropbox request failed (${res.status})`,
      res.status,
      summary,
    );
  }
}

/**
 * Ensure a folder exists. Dropbox `files/upload` auto-creates parent folders,
 * so this is only needed when you want an empty folder up front. Idempotent:
 * an existing-folder conflict is treated as success.
 */
export async function ensureFolder(path: string): Promise<void> {
  const res = await fetch(`${RPC_BASE}/files/create_folder_v2`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path, autorename: false }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.ok) return;
  const text = await res.text().catch(() => "");
  // Already exists is fine; anything else is a real error.
  if (res.status === 409 && text.includes("conflict")) return;
  throw new DropboxError(
    `Dropbox create_folder failed (${res.status})`,
    res.status,
    text,
  );
}

/**
 * Upload bytes to `path`, overwriting any existing object. Parent folders are
 * created automatically. Returns the canonical stored path Dropbox reports.
 */
export async function uploadFile(
  path: string,
  bytes: Buffer,
): Promise<{ path: string }> {
  const res = await dropboxFetch(`${CONTENT_BASE}/files/upload`, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({
        path,
        mode: "overwrite",
        autorename: false,
        mute: true,
        strict_conflict: false,
      }),
    },
    body: bytes,
  });
  const data = (await res.json()) as { path_lower?: string; path_display?: string };
  return { path: data.path_display ?? data.path_lower ?? path };
}

/**
 * Generate a short-lived temporary direct link to a stored object. Dropbox
 * temporary links are valid for ~4 hours and require no auth to fetch, so they
 * are generated fresh per view and never stored — screenshots stay private.
 */
export async function getTemporaryLink(path: string): Promise<string> {
  const res = await dropboxFetch(`${RPC_BASE}/files/get_temporary_link`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  const data = (await res.json()) as { link?: string };
  if (!data.link) {
    throw new Error("Dropbox get_temporary_link returned no link");
  }
  return data.link;
}

/** Permanently delete a stored object. A missing object is treated as success. */
export async function deleteFile(path: string): Promise<void> {
  try {
    await dropboxFetch(`${RPC_BASE}/files/delete_v2`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
  } catch (err) {
    // If it's already gone, that's fine; re-throw anything else.
    if (err instanceof DropboxError && err.summary?.includes("path_lookup")) {
      logger.warn({ path }, "Dropbox delete: object already absent");
      return;
    }
    throw err;
  }
}

export { DropboxError };
