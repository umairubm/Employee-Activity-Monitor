import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/github", () => ({
  releaseRepo: () => ({ owner: "example", repo: "agents" }),
}));
import { getUnsignedWindowsTestBuild } from "../src/lib/github-test-builds";

const run = {
  id: 123, head_branch: "windows-test-1.2.17-20260917090548",
  status: "completed", conclusion: "success", event: "push",
};
const artifact = {
  id: 456, name: "windows-UNSIGNED-DEVELOPMENT-not-for-rollout",
  expired: false, expires_at: "2099-01-01T00:00:00Z",
  size_in_bytes: 123456, updated_at: "2026-09-17T09:10:00Z",
};
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

describe("unsigned Windows test-build discovery", () => {
  it("returns a separate GitHub artifact ZIP without needing a signing credential", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ workflow_runs: [run] }))
      .mockResolvedValueOnce(response({ artifacts: [artifact] }));
    expect(await getUnsignedWindowsTestBuild(fetcher)).toEqual({
      fileName: `${artifact.name}.zip`,
      version: "1.2.17", sizeBytes: 123456, updatedAt: artifact.updated_at,
      downloadUrl: "https://github.com/example/agents/actions/runs/123/artifacts/456",
    });
    expect(fetcher.mock.calls[0][0]).toContain("build-unsigned-windows-test.yml");
    expect(fetcher.mock.calls[0][1]?.headers).not.toHaveProperty("Authorization");
  });

  it.each([
    { ...artifact, expired: true },
    { ...artifact, expires_at: "2000-01-01T00:00:00Z" },
    { ...artifact, name: "windows-installer-signed" },
  ])("does not expose expired or unrelated artifacts: %j", async (candidate) => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ workflow_runs: [run] }))
      .mockResolvedValueOnce(response({ artifacts: [candidate] }));
    expect(await getUnsignedWindowsTestBuild(fetcher)).toBeNull();
  });

  it("ignores failed, unfinished, and pull-request builds", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({
      workflow_runs: [
        { ...run, conclusion: "failure" },
        { ...run, status: "in_progress" },
        { ...run, event: "pull_request" },
      ],
    }));
    expect(await getUnsignedWindowsTestBuild(fetcher)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports lookup failures instead of claiming no build exists", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({}, 403));
    await expect(getUnsignedWindowsTestBuild(fetcher)).rejects.toThrow("lookup failed (403)");
  });
});