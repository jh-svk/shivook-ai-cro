import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";

const execFileAsync = promisify(execFile);

function githubToken(): string {
  const t = process.env.GITHUB_TOKEN;
  if (!t) throw new Error("GITHUB_TOKEN is not set");
  return t;
}

export async function getRepoSlug(): Promise<string> {
  // Env var is primary — Railway strips .git from deployed containers
  if (process.env.GITHUB_REPO) return process.env.GITHUB_REPO;
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
      cwd: process.cwd(),
    });
    const url = stdout.trim();
    const match = url.match(/github\.com[/:](.+\/.+?)(?:\.git)?$/);
    if (match) return match[1];
    throw new Error(`Could not parse repo slug from: ${url}`);
  } catch {
    throw new Error("GITHUB_REPO env var is not set and git remote lookup failed");
  }
}

export async function cloneRepo(destDir: string, repoSlug: string): Promise<void> {
  const token = githubToken();
  const cloneUrl = `https://x-access-token:${token}@github.com/${repoSlug}.git`;
  await execFileAsync("git", ["clone", cloneUrl, destDir]);
  await execFileAsync("npm", ["install"], { cwd: destDir, timeout: 300_000 });
}

export async function configureGit(cloneDir: string): Promise<void> {
  await execFileAsync("git", ["config", "user.email", "builder@shivook.com"], { cwd: cloneDir });
  await execFileAsync("git", ["config", "user.name", "Shivook AI Builder"], { cwd: cloneDir });
}

export async function createBranch(cloneDir: string, branch: string): Promise<void> {
  await execFileAsync("git", ["checkout", "-b", branch], { cwd: cloneDir });
}

export async function commitAll(cloneDir: string, message: string): Promise<void> {
  await execFileAsync("git", ["add", "-A"], { cwd: cloneDir });
  try {
    await execFileAsync("git", ["commit", "-m", message], { cwd: cloneDir });
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string };
    const output = (e.stderr ?? "") + (e.stdout ?? "");
    if (output.includes("nothing to commit")) return;
    throw err;
  }
}

export async function pushBranch(
  cloneDir: string,
  branch: string,
  repoSlug: string
): Promise<void> {
  const token = githubToken();
  const remoteUrl = `https://x-access-token:${token}@github.com/${repoSlug}.git`;
  await execFileAsync("git", ["remote", "set-url", "origin", remoteUrl], { cwd: cloneDir });
  await execFileAsync("git", ["push", "origin", branch], { cwd: cloneDir });
}

export async function createPR(
  repoSlug: string,
  branch: string,
  title: string,
  body: string
): Promise<{ prNumber: number; prUrl: string }> {
  const token = githubToken();
  const response = await fetch(`https://api.github.com/repos/${repoSlug}/pulls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, body, head: branch, base: "main" }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub PR creation failed (${response.status}): ${text}`);
  }

  const data = await response.json() as { number: number; html_url: string };
  return { prNumber: data.number, prUrl: data.html_url };
}

export async function waitForCIAndMerge(
  repoSlug: string,
  prNumber: number,
  timeoutMs = 600_000
): Promise<void> {
  const token = githubToken();
  const deadline = Date.now() + timeoutMs;
  let dirtyCount = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 30_000));

    const res = await fetch(`https://api.github.com/repos/${repoSlug}/pulls/${prNumber}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!res.ok) continue;

    const data = await res.json() as { mergeable_state: string };
    const state = data.mergeable_state;

    if (state === "clean") {
      const mergeRes = await fetch(
        `https://api.github.com/repos/${repoSlug}/pulls/${prNumber}/merge`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ merge_method: "squash" }),
        }
      );
      if (!mergeRes.ok) {
        const text = await mergeRes.text();
        throw new Error(`Merge failed (${mergeRes.status}): ${text}`);
      }
      return;
    }

    if (state === "dirty" || state === "blocked") {
      dirtyCount++;
      if (dirtyCount >= 3) throw new Error(`PR is in unresolvable state: ${state}`);
    } else {
      dirtyCount = 0;
    }
  }

  throw new Error("CI timeout: PR did not reach a mergeable state within the allowed time");
}

export async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}
