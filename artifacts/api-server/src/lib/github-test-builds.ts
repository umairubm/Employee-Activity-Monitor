import { releaseRepo } from "./github";

const ARTIFACT_NAME = "windows-UNSIGNED-DEVELOPMENT-not-for-rollout";
const WORKFLOW = "build-unsigned-windows-test.yml";

interface TestRun {
  id: number;
  head_branch: string;
  status: string;
  conclusion: string | null;
  event: string;
}

interface TestArtifact {
  id: number;
  name: string;
  expired: boolean;
  expires_at: string;
  size_in_bytes: number;
  updated_at: string;
}

/**
 * Discover Actions artifacts separately from production release assets.
 * Metadata is public for this project's public repository. Downloading the
 * ZIP happens on GitHub and requires the user's own GitHub sign-in; no token
 * or short-lived signed download URL is exposed to the dashboard.
 */
export async function getUnsignedWindowsTestBuild(fetcher: typeof fetch = fetch) {
  const { owner, repo } = releaseRepo();
  const repository = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const api = `https://api.github.com/repos/${repository}/actions`;
  const read = async (path: string) => {
    const response = await fetcher(`${api}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "workforce-agent-test-downloads",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`GitHub test-build lookup failed (${response.status})`);
    }
    return response.json();
  };

  const { workflow_runs: runs } = await read(
    `/workflows/${WORKFLOW}/runs?status=success&per_page=5`,
  ) as { workflow_runs: TestRun[] };

  for (const run of runs) {
    if (run.status !== "completed" || run.conclusion !== "success" ||
        !["push", "workflow_dispatch"].includes(run.event)) continue;
    const { artifacts } = await read(`/runs/${run.id}/artifacts?per_page=100`) as {
      artifacts: TestArtifact[];
    };
    const artifact = artifacts.find((a) =>
      a.name === ARTIFACT_NAME && !a.expired &&
      Date.parse(a.expires_at) > Date.now(),
    );
    if (!artifact) continue;
    return {
      fileName: `${artifact.name}.zip`,
      sizeBytes: artifact.size_in_bytes,
      version: run.head_branch.match(/^windows-test-(\d+\.\d+\.\d+)/)?.[1] ?? run.head_branch,
      updatedAt: artifact.updated_at,
      downloadUrl: `https://github.com/${repository}/actions/runs/${run.id}/artifacts/${artifact.id}`,
    };
  }
  return null;
}