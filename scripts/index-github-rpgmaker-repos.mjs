import fs from "node:fs/promises";
import path from "node:path";

import { shortHash, sourceKey } from "./repo-identity.mjs";
import { normalizeList } from "./normalize-list.mjs";
import { getScriptSources, getStartupScripts, looksLikeRpgMakerEntry, resolveRepoReference } from "./rpgmaker-project.mjs";

const apiBase = "https://api.github.com";
const token = process.env.WEBRPG_SEARCH_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
const listPath = process.env.LIST_PATH || "list.json";
const searchMaxPages = parsePositiveInt(process.env.SEARCH_MAX_PAGES || "10");
const searchPerPage = parsePositiveInt(process.env.SEARCH_PER_PAGE || "100");
const searchDelayMs = parseNonNegativeInt(process.env.SEARCH_DELAY_SECONDS || "8") * 1000;
const queuePath = process.env.CANDIDATE_QUEUE_PATH || "candidate-queue.json";
const candidateLimit = parsePositiveInt(process.env.MAX_CANDIDATES_PER_RUN || "32");
const skipOrg = process.env.SKIP_ORG || "WebRPG-org";
const now = new Date().toISOString();
const queries = [
  { query: "rpg_core.js extension:html", engine: "RPG Maker MV" },
  { query: "rmmz_core.js extension:html", engine: "RPG Maker MZ" },
  { query: "rmmz_core.js filename:main.js", engine: "RPG Maker MZ", kind: "main" },
];

if (!token) {
  throw new Error("WEBRPG_SEARCH_TOKEN, GH_TOKEN, or GITHUB_TOKEN is required.");
}

const list = JSON.parse(await fs.readFile(listPath, "utf8"));
const existingRepoKeys = new Set(list.map((entry) => `${entry.owner}/${entry.name}`.toLowerCase()));
const pending = JSON.parse(await fs.readFile(queuePath, "utf8").catch((error) => {
  if (error.code === "ENOENT") return "[]";
  throw error;
}));
const candidates = new Map(pending.filter((item) => !existingRepoKeys.has(sourceKey(item))).map((item) => [sourceKey(item), item]));

for (const { query, engine, kind = "html" } of queries) {
  for (let page = 1; page <= searchMaxPages; page += 1) {
    const search = await githubRequest(`/search/code?q=${encodeURIComponent(query)}&per_page=${searchPerPage}&page=${page}`);
    const items = search.items || [];
    console.log(`[search] ${query} page ${page}: ${items.length}`);

    for (const item of items) {
      const repo = item.repository;
      const fullName = repo.full_name;
      const repoKey = fullName.toLowerCase();

      if (existingRepoKeys.has(repoKey)) {
        continue;
      }

      // Skip repositories that belong to our own organization to avoid
      // indexing and re-forking repos that we already host.
      if (repo.owner.login.toLowerCase() === skipOrg.toLowerCase()) {
        continue;
      }

      if (!candidates.has(repoKey)) {
        candidates.set(repoKey, { owner: repo.owner.login, name: repo.name, repo: repo.html_url, discoveredAt: now, paths: [] });
      }
      const candidate = candidates.get(repoKey);
      candidate.paths ||= [{ path: candidate.path, sha: candidate.sha, engine: candidate.engine, kind: "html" }];
      const previous = candidate.paths.find((entry) => entry.path === item.path);
      if (previous) Object.assign(previous, { sha: item.sha, engine, kind });
      if (candidate.paths.length < 20 && !previous) {
        candidate.paths.push({ path: item.path, sha: item.sha, engine, kind });
      }
    }

    if (items.length < searchPerPage) {
      break;
    }

    await sleep(searchDelayMs);
  }
}

// Queue candidates before fetching blobs. A finite request budget must defer
// work to a later run, rather than permanently excluding same-name games.
await saveQueue();
const additions = [];
const usedIds = new Set(list.map((entry) => entry.id));
for (const [key, candidate] of [...candidates].slice(0, candidateLimit)) {
  try {
    const entry = await inspectCandidate(candidate);
    if (entry) {
      let id = makeEntryId(candidate.owner, candidate.name);
      if (usedIds.has(id)) id = `${id}-${shortHash(key)}`;
      usedIds.add(id);
      additions.push({ id, title: extractTitle(entry.html) || candidate.name, repo: candidate.repo, owner: candidate.owner, name: candidate.name, engine: entry.engine, status: "indexed", discoveredAt: candidate.discoveredAt || now, source: "github-code-search", sourcePath: entry.path });
    }
    candidates.delete(key);
  } catch (error) {
    candidates.delete(key);
    if (error.status !== 404) candidates.set(key, candidate);
    console.log(`[candidate-error] ${key}: ${error.message}`);
  }
}
await saveQueue();

const merged = normalizeList([...list, ...additions]);
merged.sort((left, right) => left.title.localeCompare(right.title, "zh-Hans") || left.repo.localeCompare(right.repo, "en"));
await fs.writeFile(listPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

const duplicateCount = merged.filter((entry) => entry.status === "duplicate_name").length;
console.log(`New entries added: ${additions.length}`);
console.log(`Entries marked duplicate_name: ${duplicateCount}`);

await writeStepSummary([
  "# GitHub RPG Maker index",
  "",
  `New entries added: \`${additions.length}\``,
  `Entries marked duplicate_name: \`${duplicateCount}\``,
  `Search queries: \`${queries.map((item) => item.query).join("`, `")}\``,
]);

async function saveQueue() {
  await fs.writeFile(queuePath, `${JSON.stringify([...candidates.values()], null, 2)}\n`, "utf8");
}

async function inspectCandidate(candidate) {
  for (const location of candidate.paths || []) {
    const repoPath = `/repos/${encodeURIComponent(candidate.owner)}/${encodeURIComponent(candidate.name)}`;
    const blob = await githubRequest(`${repoPath}/git/blobs/${location.sha}`);
    const content = Buffer.from(blob.content, blob.encoding).toString("utf8");
    if (location.kind !== "main") {
      if (looksLikeRpgMakerEntry(content, location.engine)) return { html: content, path: location.path, engine: location.engine };
      continue;
    }
    if (!getStartupScripts("", content).dynamic.some((src) => /(?:^|\/)rmmz_core\.js(?:[?#]|$)/i.test(src))) continue;
    const projectRoot = path.posix.dirname(path.posix.dirname(location.path));
    const directory = projectRoot === "." ? "" : projectRoot.split("/").map(encodeURIComponent).join("/");
    const files = await githubRequest(`${repoPath}/contents/${directory}`);
    for (const file of Array.isArray(files) ? files : []) {
      if (file.type !== "file" || !file.path.toLowerCase().endsWith(".html")) continue;
      const htmlBlob = await githubRequest(`${repoPath}/git/blobs/${file.sha}`);
      const html = Buffer.from(htmlBlob.content, htmlBlob.encoding).toString("utf8");
      if (getScriptSources(html).some((src) => resolveRepoReference(file.path, src) === location.path)) {
        return { html, path: file.path, engine: "RPG Maker MZ" };
      }
    }
  }
  return null;
}

function extractTitle(html) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    .replace(/\s+/g, " ")
    .trim();

  return decodeHtmlEntities(title || "");
}

function decodeHtmlEntities(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

async function githubRequest(path, options = {}) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
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
    const data = parseResponseBody(text);

    if (response.ok) {
      return data;
    }

    if (![403, 429].includes(response.status) || attempt === 4) {
      throw Object.assign(new Error(`GitHub API ${response.status}: ${data?.message || response.statusText}`), { status: response.status });
    }

    const retryAfter = Number.parseInt(response.headers.get("retry-after") || "", 10);
    const reset = Number.parseInt(response.headers.get("x-ratelimit-reset") || "", 10);
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Number.isFinite(reset) && reset > 0
        ? Math.max(reset * 1000 - Date.now() + 5000, 15000)
        : 60000 * (attempt + 1);
    console.log(`[retry] GitHub API ${response.status}; waiting ${Math.ceil(waitMs / 1000)}s`);
    await sleep(waitMs);
  }

  throw new Error("Unexpected GitHub retry exhaustion.");
}

function makeEntryId(owner, name) {
  const base = `${owner}-${name}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base || `repo-${shortHash(`${owner}/${name}`)}`;
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

function parsePositiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got ${value}.`);
  }

  return parsed;
}

function parseNonNegativeInt(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer, got ${value}.`);
  }

  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function writeStepSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) {
    return;
  }

  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}
