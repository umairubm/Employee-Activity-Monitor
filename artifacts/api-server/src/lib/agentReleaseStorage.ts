import { randomUUID } from "crypto";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

function getPrivateObjectDir(): string {
  const dir = process.env.PRIVATE_OBJECT_DIR?.trim();
  if (!dir) {
    throw new Error("PRIVATE_OBJECT_DIR is not configured");
  }
  return dir.replace(/\/+$/, "");
}

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const parts = normalized.split("/");
  if (parts.length < 3 || !parts[1] || !parts.slice(2).join("/")) {
    throw new Error("Invalid object storage path");
  }
  return { bucketName: parts[1], objectName: parts.slice(2).join("/") };
}

async function signObjectUrl({
  bucketName,
  objectName,
  method,
  ttlSec,
}: {
  bucketName: string;
  objectName: string;
  method: "GET" | "PUT";
  ttlSec: number;
}): Promise<string> {
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bucket_name: bucketName,
        object_name: objectName,
        method,
        expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Object storage signing failed (${response.status})`);
  }
  const data = (await response.json()) as { signed_url?: string };
  if (!data.signed_url) throw new Error("Object storage returned no signed URL");
  return data.signed_url;
}

function safeFileName(name: string): string {
  const basename = name.replace(/\\/g, "/").split("/").pop() ?? "installer";
  const safe = basename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);
  return safe || "installer";
}

export async function createAgentReleaseUpload(
  companyId: string,
  fileName: string,
): Promise<{
  uploadURL: string;
  objectPath: string;
}> {
  const objectId = randomUUID();
  const safeName = safeFileName(fileName);
  const fullPath = `${getPrivateObjectDir()}/agent-releases/${companyId}/${objectId}-${safeName}`;
  const { bucketName, objectName } = parseObjectPath(fullPath);
  return {
    uploadURL: await signObjectUrl({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: 15 * 60,
    }),
    objectPath: `/objects/${objectName}`,
  };
}

export async function getAgentReleaseDownloadUrl(
  objectPath: string,
  ttlSec = 15 * 60,
): Promise<string> {
  if (!objectPath.startsWith("/objects/")) {
    throw new Error("Invalid agent release object path");
  }
  const entityPath = objectPath.slice("/objects/".length);
  const { bucketName, objectName } = parseObjectPath(
    `${getPrivateObjectDir()}/${entityPath}`,
  );
  return signObjectUrl({ bucketName, objectName, method: "GET", ttlSec });
}