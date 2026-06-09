import { Readable } from "node:stream";
import type { Response } from "express";
import { logger } from "./logger";

/**
 * GitHub release access for serving the desktop-agent installers.
 *
 * Uses the Replit GitHub integration (connection name: `github`). A fresh
 * access token is fetched from the Replit connectors proxy on every call —
 * tokens expire, so they are never cached. See the `integrations` skill
 * (GitHub blueprint) for the connector contract.
 *
 * The repo that hosts the release assets defaults to the project's own repo and
 * can be overridden with `GITHUB_RELEASE_REPO` (`owner/repo`).
 */

const GITHUB_API = "https://api.github.com";

export function releaseRepo(): { owner: string; repo: string } {
  const full = process.env.GITHUB_RELEASE_REPO || "umairubm/Employee-Activity-Monitor";
  const [owner, repo] = full.split("/");
  return { owner: owner ?? "", repo: repo ?? "" };
}

async function getAccessToken(): Promise<string> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;
  if (!hostname || !xReplitToken) {
    throw new Error("GitHub connection is not available in this environment");
  }
  const res = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=github`,
    { headers: { Accept: "application/json", X_REPLIT_TOKEN: xReplitToken } },
  );
  if (!res.ok) {
    throw new Error(`GitHub connector lookup failed (${res.status})`);
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
  const token = settings?.access_token ?? settings?.oauth?.credentials?.access_token;
  if (!token) {
    throw new Error("No GitHub access token found on the connection");
  }
  return token;
}

function ghHeaders(token: string, accept: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "workforce-agent-downloads",
  };
}

export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  updatedAt: string;
  apiUrl: string;
}

export interface LatestRelease {
  tag: string;
  assets: ReleaseAsset[];
}

/** Fetch the latest published release, or `null` if none exists yet. */
export async function getLatestRelease(): Promise<LatestRelease | null> {
  const token = await getAccessToken();
  const { owner, repo } = releaseRepo();
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/releases/latest`,
    { headers: ghHeaders(token, "application/vnd.github+json") },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GitHub releases lookup failed (${res.status})`);
  }
  const data = (await res.json()) as {
    tag_name: string;
    assets?: Array<{ id: number; name: string; size: number; updated_at: string; url: string }>;
  };
  return {
    tag: data.tag_name,
    assets: (data.assets ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      size: a.size,
      updatedAt: a.updated_at,
      apiUrl: a.url,
    })),
  };
}

const PLATFORM_EXT: Record<string, string> = {
  windows: ".exe",
  macos: ".dmg",
};

export function assetForPlatform(
  release: LatestRelease,
  platform: string,
): ReleaseAsset | undefined {
  const ext = PLATFORM_EXT[platform];
  if (!ext) return undefined;
  return release.assets.find((a) => a.name.toLowerCase().endsWith(ext));
}

/** Stream a release asset's bytes through to the client as an attachment. */
export async function streamAsset(asset: ReleaseAsset, res: Response): Promise<void> {
  const token = await getAccessToken();
  const ghRes = await fetch(asset.apiUrl, {
    headers: ghHeaders(token, "application/octet-stream"),
  });
  if (!ghRes.ok || !ghRes.body) {
    throw new Error(`Asset download failed (${ghRes.status})`);
  }
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${asset.name.replace(/"/g, "")}"`,
  );
  if (asset.size) res.setHeader("Content-Length", String(asset.size));

  Readable.fromWeb(ghRes.body as Parameters<typeof Readable.fromWeb>[0])
    .on("error", (err) => {
      logger.error({ err }, "asset stream error");
      if (!res.headersSent) res.status(502).end();
    })
    .pipe(res);
}
