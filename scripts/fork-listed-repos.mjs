import crypto from "node:crypto";
import fs from "node:fs/promises";

const apiBase = "https://api.github.com";
const token = process.env.WEBRPG_FORK_TOKEN || process.env.GITHUB_TOKEN || "";
const targetOrg = process.env.TARGET_ORG || "WebRPG-org";
const dryRun = parseBoolean(process.env.DRY_RUN, true);
const defaultBranchOnly = parseBoolean(process.env.DEFAULT_BRANCH_ONLY, false);
const limit = parseNonNegativeInt(process.env.LIMIT || "0");
const createDelayMs = parseNonNegativeInt(process.env.CREATE_DELAY_SECONDS || "20") * 1000;
const retryLimit = parseNonNegativeInt(process.env.RETRY_LIMIT || "5");
const retryBaseDelayMs = parseNonNegativeInt(process.env.RETRY_BASE_DELAY_SECONDS || "60") * 1000;
const retryMaxDelayMs = 15 * 60 * 1000;
const includeInvalid = parseBoolean(process.env.INCLUDE_INVALID, false);

class GitHubApiError extends Error {
  constructor(status, message, details) {
    super(`GitHub API ${status}: ${message}`);
    this.name = "GitHubApiError";
    this.status = status;
    this.details = details;
  }
}

const list = JSON.parse(await fs.readFile("list.json", "utf8"));
const uniqueSources = getUniqueSources(list);
const planned = limit > 0 ? uniqueSources.slice(0, limit) : uniqueSources;

if (!targetOrg) {
  throw new Error("TARGET_ORG is required.");
}

if (!dryRun && !token) {
  throw new Error("WEBRPG_FORK_TOKEN is required when DRY_RUN is false.");
}

const summary = [];
summary.push(`# Fork listed repositories`);
summary.push("");
summary.push(`Target organization: \`${targetOrg}\``);
summary.push(`Dry run: \`${dryRun}\``);
summary.push(`Default branch only: \`${defaultBranchOnly}\``);
summary.push(`Unique source repositories: \`${uniqueSources.length}\``);
summary.push(`Repositories in this run: \`${planned.length}\``);
summary.push(`Delay between fork requests: \`${createDelayMs / 1000}s\``);
summary.push(`Retry limit: \`${retryLimit}\``);
summary.push(`Include invalid entries: \`${includeInvalid}\``);
summary.push("");

console.log(`Loaded ${list.length} index entries.`);
console.log(`Found ${uniqueSources.length} unique source repositories.`);
console.log(`Processing ${planned.length} repositories for ${targetOrg}.`);

if (dryRun) {
  for (const item of planned) {
    console.log(`[dry-run] ${item.source} -> ${targetOrg}/${item.forkName}`);
  }

  summary.push("## Planned forks");
  for (const item of planned) {
    summary.push(`- \`${item.source}\` -> \`${targetOrg}/${item.forkName}\``);
  }
  await writeStepSummary(summary);
  process.exit(0);
}

const existing = await loadExistingOrgRepos(targetOrg);
let lastCreateAttemptAt = 0;
let skippedExisting = 0;
let skippedConflict = 0;
let created = 0;
let failed = 0;
const failures = [];

for (const item of planned) {
  const sourceLower = item.source.toLowerCase();
  const nameLower = item.forkName.toLowerCase();
  const existingFork = existing.forksBySource.get(sourceLower);

  if (existingFork) {
    skippedExisting += 1;
    console.log(`[exists] ${item.source} already forked as ${targetOrg}/${existingFork.name}`);
    continue;
  }

  const existingByName = existing.reposByName.get(nameLower);
  if (existingByName) {
    skippedConflict += 1;
    console.log(`[conflict] ${targetOrg}/${item.forkName} already exists and is not a fork of ${item.source}`);
    continue;
  }

  try {
    const fork = await createForkWithRetry(item);
    created += 1;
    existing.reposByName.set(nameLower, fork);
    existing.forksBySource.set(sourceLower, fork);
    console.log(`[created] ${item.source} -> ${targetOrg}/${item.forkName}`);
  } catch (error) {
    failed += 1;
    failures.push({ item, error });
    console.log(`[failed] ${item.source}: ${error.message}`);
  }
}

summary.push("## Result");
summary.push(`- Created: \`${created}\``);
summary.push(`- Already forked: \`${skippedExisting}\``);
summary.push(`- Name conflicts: \`${skippedConflict}\``);
summary.push(`- Failed: \`${failed}\``);

if (failures.length > 0) {
  summary.push("");
  summary.push("## Failures");
  for (const { item, error } of failures) {
    summary.push(`- \`${item.source}\`: ${error.message}`);
  }
}

await writeStepSummary(summary);

if (failed > 0) {
  // Individual fork failures are non-fatal; the workflow uses continue-on-error.
}

function getUniqueSources(entries) {
  const bySource = new Map();
  const seenRepoNames = new Set();

  for (const entry of entries) {
    if (!includeInvalid && isInvalidEntry(entry)) {
      continue;
    }

    if (!entry.owner || !entry.name || !entry.repo) {
      throw new Error(`Invalid list entry: ${JSON.stringify(entry)}`);
    }

    const source = `${entry.owner}/${entry.name}`;
    const sourceKey = source.toLowerCase();
    const repoNameKey = String(entry.name).toLowerCase();

    if (seenRepoNames.has(repoNameKey)) {
      continue;
    }
    seenRepoNames.add(repoNameKey);

    if (!bySource.has(sourceKey)) {
      bySource.set(sourceKey, {
        source,
        owner: entry.owner,
        name: entry.name,
        repo: entry.repo,
        forkName: makeForkName(entry.owner, entry.name),
      });
    }
  }

  const usedNames = new Map();
  for (const item of bySource.values()) {
    const nameKey = item.forkName.toLowerCase();
    const existingSource = usedNames.get(nameKey);
    if (existingSource && existingSource !== item.source.toLowerCase()) {
      item.forkName = makeForkName(item.owner, `${item.name}-${shortHash(item.source)}`);
    }
    usedNames.set(item.forkName.toLowerCase(), item.source.toLowerCase());
  }

  return [...bySource.values()].sort((left, right) => left.source.localeCompare(right.source, "en"));
}

function makeForkName(owner, name) {
  const raw = `${owner}-${name}`;
  let safe = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");

  if (!safe) {
    safe = `repo-${shortHash(raw)}`;
  }

  if (safe.length <= 100) {
    return safe;
  }

  return `${safe.slice(0, 91).replace(/[.-]+$/g, "")}-${shortHash(raw)}`;
}

function isInvalidEntry(entry) {
  return ["invalid_structure", "deleted_invalid_structure", "duplicate_name"].includes(entry.status);
}

async function loadExistingOrgRepos(org) {
  const reposByName = new Map();
  const forksBySource = new Map();

  for (let page = 1; ; page += 1) {
    const repos = await githubRequest(`/orgs/${encodeURIComponent(org)}/repos?type=all&per_page=100&page=${page}`);
    if (repos.length === 0) {
      break;
    }

    for (const repo of repos) {
      reposByName.set(repo.name.toLowerCase(), repo);
      const repoDetails = repo.fork && !repo.source && !repo.parent
        ? await githubRequest(`/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo.name)}`)
        : repo;
      const source = repoDetails.source?.full_name || repoDetails.parent?.full_name;
      if (repo.fork && source) {
        forksBySource.set(source.toLowerCase(), repo);
      }
    }
  }

  return { reposByName, forksBySource };
}

async function createFork(item) {
  return githubRequest(`/repos/${encodeURIComponent(item.owner)}/${encodeURIComponent(item.name)}/forks`, {
    method: "POST",
    body: {
      organization: targetOrg,
      name: item.forkName,
      default_branch_only: defaultBranchOnly,
    },
    ok: [202],
  });
}

async function createForkWithRetry(item) {
  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    await waitForCreateSlot();
    lastCreateAttemptAt = Date.now();

    try {
      return await createFork(item);
    } catch (error) {
      if (attempt >= retryLimit || !isRetryableGitHubError(error)) {
        throw error;
      }

      const delayMs = getRetryDelayMs(error, attempt);
      console.log(
        `[retry] ${item.source}: ${error.message}; waiting ${formatDuration(delayMs)} before retry ${attempt + 1}/${retryLimit}`,
      );
      await sleep(delayMs);
    }
  }

  throw new Error(`Unexpected retry exhaustion for ${item.source}.`);
}

async function waitForCreateSlot() {
  if (createDelayMs <= 0 || lastCreateAttemptAt === 0) {
    return;
  }

  const elapsedMs = Date.now() - lastCreateAttemptAt;
  const remainingMs = createDelayMs - elapsedMs;

  if (remainingMs > 0) {
    console.log(`[throttle] waiting ${formatDuration(remainingMs)} before next fork request`);
    await sleep(remainingMs);
  }
}

async function githubRequest(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method: options.method || "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  const data = parseResponseBody(text);
  const ok = options.ok || [200];

  if (!ok.includes(response.status)) {
    const message = data?.message || response.statusText;
    throw new GitHubApiError(response.status, message, {
      path,
      retryAfter: response.headers.get("retry-after"),
      rateLimitReset: response.headers.get("x-ratelimit-reset"),
    });
  }

  return data;
}

function parseResponseBody(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function isRetryableGitHubError(error) {
  if (!(error instanceof GitHubApiError)) {
    return false;
  }

  if (error.status >= 500) {
    return true;
  }

  if (![403, 429].includes(error.status)) {
    return false;
  }

  if (error.details?.retryAfter) {
    return true;
  }

  return /abuse|rate limit|secondary|submitted too quickly|try again later/i.test(error.message);
}

function getRetryDelayMs(error, attempt) {
  const retryAfterSeconds = Number.parseInt(error.details?.retryAfter || "", 10);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, retryMaxDelayMs);
  }

  const resetSeconds = Number.parseInt(error.details?.rateLimitReset || "", 10);
  if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
    const resetDelayMs = resetSeconds * 1000 - Date.now() + 5000;
    if (resetDelayMs > 0 && resetDelayMs < retryMaxDelayMs) {
      return resetDelayMs;
    }
  }

  return Math.min(retryBaseDelayMs * (2 ** attempt), retryMaxDelayMs);
}

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === "") {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseNonNegativeInt(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`LIMIT must be a non-negative integer, got ${value}.`);
  }

  return parsed;
}

function shortHash(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatDuration(ms) {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

async function writeStepSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) {
    return;
  }

  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}
