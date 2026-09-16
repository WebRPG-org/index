import fs from "node:fs/promises";

import { isPlanSkipped } from "./repo-status.mjs";
import { getUniqueSources, getForkNames, readForkFailures, readForkRecords } from "./repo-identity.mjs";

const apiBase = "https://api.github.com";
const token = process.env.WEBRPG_APP_TOKEN || process.env.GITHUB_TOKEN || "";
const targetOrg = process.env.TARGET_ORG || "WebRPG-org";
const limit = parseNonNegativeInt(process.env.LIMIT || "0");
const maxMatrixSize = parseNonNegativeInt(process.env.MAX_MATRIX_SIZE || "256");

if (!token) {
  throw new Error("WEBRPG_APP_TOKEN or GITHUB_TOKEN is required.");
}

const list = JSON.parse(await fs.readFile(process.env.LIST_PATH || "list.json", "utf8"));
const forkRecords = await readForkRecords(process.env.FORK_FAILURES_DIR || "workflow-failures");
const forkFailures = await readForkFailures(process.env.FORK_FAILURES_DIR || "workflow-failures");
const sources = getUniqueSources(list, forkRecords).filter((item) => !isPlanSkipped(item.entry) && (forkRecords.has(item.key) || forkFailures.get(item.key)?.kind !== "permanent"));
const sourceByFork = new Map();
for (const source of sources) {
  const key = source.forkName.toLowerCase();
  if (!sourceByFork.has(key)) sourceByFork.set(key, source);
}
const indexedNames = new Set(sourceByFork.keys());
const lastCheckedByFork = getLastCheckedByFork(list, getForkNames(list, forkRecords));
const orgRepos = await loadOrgRepos(targetOrg);
const targets = orgRepos
  // Membership in the index is what makes a repository ours. The fork flag is
  // not a reliable test: a fork loses it when its upstream is deleted, made
  // private or transferred away, and those repositories used to drop out of
  // the pipeline for good while still holding the only copy of the game.
  .filter((repo) => indexedNames.has(repo.name.toLowerCase()))
  .sort((left, right) => {
    // Least recently checked first, so every fork is revisited in turn.
    // Ordering by the repository's own updated_at stranded forks that fail
    // validation: a failed run never bumps updated_at, so the same handful of
    // repositories was retried on every run while the rest of the queue never
    // advanced.
    const leftChecked = lastCheckedByFork.get(left.name.toLowerCase()) || "";
    const rightChecked = lastCheckedByFork.get(right.name.toLowerCase()) || "";
    return leftChecked.localeCompare(rightChecked, "en") || left.name.localeCompare(right.name, "en");
  });
const planned = limit > 0 ? targets.slice(0, limit) : targets.slice(0, maxMatrixSize);
const matrix = {
  include: planned.map((repo) => ({
    repo: repo.name,
    entryId: sourceByFork.get(repo.name.toLowerCase()).entryId,
    indexedSource: sourceByFork.get(repo.name.toLowerCase()).key,
  })),
};

await fs.mkdir("workflow-plan", { recursive: true });
await fs.writeFile(process.env.PLAN_PATH || "workflow-plan/plan.json", `${JSON.stringify({ checkedAt: new Date().toISOString(), targets: matrix.include }, null, 2)}\n`, "utf8");

console.log(`Indexed source repositories: ${indexedNames.size}`);
console.log(`Fork repositories in ${targetOrg}: ${targets.length}`);
console.log(`Repositories in this run: ${planned.length}`);
console.log(`Oldest checkedAt in this run: ${lastCheckedByFork.get(planned[0]?.name.toLowerCase()) || "never checked"}`);
console.log(`Planned repositories: ${planned.map((repo) => repo.name).join(", ")}`);

await writeOutput("matrix", JSON.stringify(matrix));
await writeOutput("has_targets", planned.length > 0 ? "true" : "false");
await writeOutput("target_count", String(planned.length));

async function loadOrgRepos(org) {
  const repos = [];

  for (let page = 1; ; page += 1) {
    const batch = await githubRequest(`/orgs/${encodeURIComponent(org)}/repos?type=all&per_page=100&page=${page}`);
    if (batch.length === 0) {
      break;
    }

    repos.push(...batch);
  }

  return repos;
}

// Latest checkedAt per fork repository. Several entries can share one fork
// (a monorepo exposing several projects); the newest timestamp wins so a
// shared fork is not pushed back to the front of the queue.
function getLastCheckedByFork(entries, names) {
  const result = new Map();

  for (const entry of entries) {
    const forkName = names.get(`${entry.owner}/${entry.name}`.toLowerCase()).toLowerCase();
    const checkedAt = entry.checkedAt || "";
    const current = result.get(forkName);

    if (current === undefined || checkedAt > current) {
      result.set(forkName, checkedAt);
    }
  }

  return result;
}

async function githubRequest(path, options = {}) {
  const maxRetries = 5;
  const baseDelayMs = 10_000;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response = await fetch(`${apiBase}${path}`, {
      method: options.method || "GET",
      headers: {
        Accept: "application/vnd.github+json",
        // GitHub rejects requests without a User-Agent. Node 22 does not send one.
        "User-Agent": "WebRPG-index/1.0",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : null;

    if (response.ok) {
      return data;
    }

    // Rate limit: retry with exponential backoff
    if (response.status === 403 || response.status === 429) {
      const delayMs = getRateLimitDelayMs(response, data, attempt, baseDelayMs);
      const remaining = response.headers.get("x-ratelimit-remaining");

      if (attempt < maxRetries) {
        const remainingText = remaining ? `; remaining ${remaining}` : "";
        console.log(`[rate-limit] ${data?.message?.slice(0, 60)}${remainingText}; waiting ${Math.round(delayMs / 1000)}s before retry ${attempt + 1}/${maxRetries}`);
        await sleep(delayMs);
        continue;
      }
    }

    throw new Error(`GitHub API ${response.status}: ${data?.message || response.statusText}`);
  }
}

function getRateLimitDelayMs(response, data, attempt, baseDelayMs) {
  const retryAfterSeconds = Number.parseInt(response.headers.get("retry-after") || data?.["retry-after"] || "", 10);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }

  const resetAtSeconds = Number.parseInt(response.headers.get("x-ratelimit-reset") || "", 10);
  if (Number.isFinite(resetAtSeconds) && resetAtSeconds > 0) {
    const untilResetMs = resetAtSeconds * 1000 - Date.now() + 5000;
    if (untilResetMs > 0) {
      return untilResetMs;
    }
  }

  return Math.min(baseDelayMs * (2 ** attempt), 300_000);
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function parseNonNegativeInt(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`LIMIT must be a non-negative integer, got ${value}.`);
  }

  return parsed;
}

async function writeOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  await fs.appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
