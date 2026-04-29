import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import fs from "fs";
import fsp from "fs/promises";

function token(): string {
  const t = process.env.GITHUB_TOKEN;
  if (!t) throw new Error("GITHUB_TOKEN is not set");
  return t;
}

function onAuth() {
  return { username: "x-access-token", password: token() };
}

export async function getRepoSlug(): Promise<string> {
  if (process.env.GITHUB_REPO) return process.env.GITHUB_REPO;
  throw new Error("GITHUB_REPO env var is not set");
}

export async function cloneRepo(destDir: string, repoSlug: string): Promise<void> {
  await git.clone({
    fs,
    http,
    dir: destDir,
    url: `https://github.com/${repoSlug}.git`,
    singleBranch: true,
    depth: 1,
    onAuth,
  });
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);
  await execFileAsync("npm", ["install", "--engine-strict=false"], { cwd: destDir, timeout: 300_000 });
}

export async function configureGit(cloneDir: string): Promise<void> {
  await git.setConfig({ fs, dir: cloneDir, path: "user.email", value: "builder@shivook.com" });
  await git.setConfig({ fs, dir: cloneDir, path: "user.name", value: "Shivook AI Builder" });
}

export async function createBranch(cloneDir: string, branch: string): Promise<void> {
  await git.branch({ fs, dir: cloneDir, ref: branch, checkout: true });
}

export async function commitAll(cloneDir: string, message: string): Promise<void> {
  const statusMatrix = await git.statusMatrix({ fs, dir: cloneDir });
  for (const [filepath, , workdirStatus, stageStatus] of statusMatrix) {
    if (workdirStatus !== stageStatus) {
      if (workdirStatus === 0) {
        await git.remove({ fs, dir: cloneDir, filepath: String(filepath) });
      } else {
        await git.add({ fs, dir: cloneDir, filepath: String(filepath) });
      }
    }
  }
  const sha = await git.commit({
    fs,
    dir: cloneDir,
    message,
    author: { name: "Shivook AI Builder", email: "builder@shivook.com" },
  });
  if (!sha) throw new Error("Nothing to commit");
}

export async function pushBranch(
  cloneDir: string,
  branch: string,
  _repoSlug: string
): Promise<void> {
  await git.push({
    fs,
    http,
    dir: cloneDir,
    remote: "origin",
    ref: branch,
    onAuth,
  });
}

export async function createPR(
  repoSlug: string,
  branch: string,
  title: string,
  body: string
): Promise<{ prNumber: number; prUrl: string }> {
  const response = await fetch(`https://api.github.com/repos/${repoSlug}/pulls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token()}`,
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
  const data = (await response.json()) as { number: number; html_url: string };
  return { prNumber: data.number, prUrl: data.html_url };
}

export async function waitForCIAndMerge(
  repoSlug: string,
  prNumber: number,
  timeoutMs = 600_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let dirtyCount = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 30_000));

    const res = await fetch(`https://api.github.com/repos/${repoSlug}/pulls/${prNumber}`, {
      headers: {
        Authorization: `Bearer ${token()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) continue;

    const data = (await res.json()) as { mergeable_state: string };
    const state = data.mergeable_state;

    if (state === "clean") {
      const mergeRes = await fetch(
        `https://api.github.com/repos/${repoSlug}/pulls/${prNumber}/merge`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token()}`,
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
  await fsp.rm(dir, { recursive: true, force: true });
}
