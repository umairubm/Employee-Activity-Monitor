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

// Per-platform asset matchers. Windows and macOS use a single, unambiguous
// installer extension. Linux has no universal installer format and our releases
// have historically shipped the Linux build as a bare PyInstaller binary with
// NO extension (e.g. "svctcom"), so the Linux matcher accepts both the common
// Linux package extensions AND an extensionless binary — while explicitly
// excluding the other platforms' installers and non-installer sidecar files
// (checksums, signatures, notes).
const WINDOWS_EXT = [".exe"];
const MACOS_EXT = [".dmg"];
const LINUX_EXT = [".tar.gz", ".tgz", ".appimage", ".deb", ".rpm"];
const NON_INSTALLER_EXT = [
  ".sha256",
  ".sha512",
  ".md5",
  ".sig",
  ".asc",
  ".txt",
  ".md",
  ".json",
  ".yml",
  ".yaml",
  ".zip",
];

function hasExt(name: string, exts: string[]): boolean {
  const lower = name.toLowerCase();
  return exts.some((e) => lower.endsWith(e));
}

// Common extensionless files that are NOT installers, so a bare-binary match
// never resolves Linux to a repo/doc/checksum file that happens to ship as an
// asset.
const BARE_NON_INSTALLER = new Set([
  "readme",
  "license",
  "licence",
  "changelog",
  "notice",
  "authors",
  "copying",
  "contributing",
  "manifest",
  "checksums",
  "sha256sums",
  "sha512sums",
  "md5sums",
]);

/** A release asset filename with no extension at all (a bare ELF binary). */
function isBareBinary(name: string): boolean {
  const base = name.split("/").pop() ?? name;
  if (base.includes(".")) return false;
  return !BARE_NON_INSTALLER.has(base.toLowerCase());
}

const PLATFORM_MATCH: Record<string, (name: string) => boolean> = {
  windows: (n) => hasExt(n, WINDOWS_EXT),
  macos: (n) => hasExt(n, MACOS_EXT),
  linux: (n) =>
    !hasExt(n, NON_INSTALLER_EXT) &&
    !hasExt(n, WINDOWS_EXT) &&
    !hasExt(n, MACOS_EXT) &&
    (hasExt(n, LINUX_EXT) || isBareBinary(n)),
};

export function assetForPlatform(
  release: LatestRelease,
  platform: string,
): ReleaseAsset | undefined {
  const match = PLATFORM_MATCH[platform];
  if (!match) return undefined;
  return release.assets.find((a) => match(a.name));
}

/**
 * Fetch recent published releases (newest first, drafts excluded). Used to
 * resolve each platform's installer independently — a release that only updates
 * one platform (e.g. macOS-only) must not hide a Windows build that is still
 * the newest `.exe` published in an earlier release.
 */
export async function getReleases(perPage = 15): Promise<LatestRelease[]> {
  const token = await getAccessToken();
  const { owner, repo } = releaseRepo();
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/releases?per_page=${perPage}`,
    { headers: ghHeaders(token, "application/vnd.github+json") },
  );
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(`GitHub releases lookup failed (${res.status})`);
  }
  const data = (await res.json()) as Array<{
    tag_name: string;
    draft?: boolean;
    published_at?: string | null;
    created_at?: string;
    assets?: Array<{ id: number; name: string; size: number; updated_at: string; url: string }>;
  }>;
  return (
    data
      .filter((r) => !r.draft)
      // GitHub's list endpoint is NOT reliably newest-first: it orders by the
      // release's created_at, which for CI-created releases can inherit an
      // older timestamp — observed in practice pushing brand-new releases to
      // the END of the list. Sort by publish date ourselves so
      // findPlatformAsset's "first match wins" scan is truly newest-first.
      .sort(
        (a, b) =>
          (Date.parse(b.published_at ?? b.created_at ?? "") || 0) -
          (Date.parse(a.published_at ?? a.created_at ?? "") || 0),
      )
      .map((r) => ({
        tag: r.tag_name,
        assets: (r.assets ?? []).map((a) => ({
          id: a.id,
          name: a.name,
          size: a.size,
          updatedAt: a.updated_at,
          apiUrl: a.url,
        })),
      }))
  );
}

/**
 * Find the newest release that actually publishes an installer for `platform`,
 * scanning releases newest-first. Returns the asset plus the tag it came from.
 */
export function findPlatformAsset(
  releases: LatestRelease[],
  platform: string,
): { asset: ReleaseAsset; tag: string } | undefined {
  const match = PLATFORM_MATCH[platform];
  if (!match) return undefined;
  for (const release of releases) {
    const asset = release.assets.find((a) => match(a.name));
    if (asset) return { asset, tag: release.tag };
  }
  return undefined;
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
