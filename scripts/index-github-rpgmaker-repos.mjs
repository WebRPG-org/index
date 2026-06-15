import crypto from "node:crypto";
import fs from "node:fs/promises";

const apiBase = "https://api.github.com";
const token = process.env.WEBRPG_SEARCH_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
const listPath = process.env.LIST_PATH || "list.json";
const searchMaxPages = parsePositiveInt(process.env.SEARCH_MAX_PAGES || "10");
const searchPerPage = parsePositiveInt(process.env.SEARCH_PER_PAGE || "100");
const searchDelayMs = parseNonNegativeInt(process.env.SEARCH_DELAY_SECONDS || "8") * 1000;
const now = new Date().toISOString();
const queries = [
  { query: "rpg_core.js extension:html", engine: "RPG Maker MV" },
  { query: "rmmz_core.js extension:html", engine: "RPG Maker MZ" },
];

if (!token) {
  throw new Error("WEBRPG_SEARCH_TOKEN, GH_TOKEN, or GITHUB_TOKEN is required.");
}

const list = JSON.parse(await fs.readFile(listPath, "utf8"));
const existingRepoKeys = new Set(list.map((entry) => `${entry.owner}/${entry.name}`.toLowerCase()));
const existingNames = new Set(list.map((entry) => String(entry.name).toLowerCase()));
const newNames = new Set();
const candidates = new Map();

for (const { query, engine } of queries) {
  for (let page = 1; page <= searchMaxPages; page += 1) {
    const search = await githubRequest(`/search/code?q=${encodeURIComponent(query)}&per_page=${searchPerPage}&page=${page}`);
    const items = search.items || [];
    console.log(`[search] ${query} page ${page}: ${items.length}`);

    for (const item of items) {
      const repo = item.repository;
      const fullName = repo.full_name;
      const repoKey = fullName.toLowerCase();
      const repoNameKey = repo.name.toLowerCase();

      // Skip fork repositories so the source link points to the original author
      if (repo.fork) {
        continue;
      }

      if (existingRepoKeys.has(repoKey) || existingNames.has(repoNameKey) || newNames.has(repoNameKey)) {
        continue;
      }

      if (!candidates.has(repoKey)) {
        candidates.set(repoKey, {
          owner: repo.owner.login,
          name: repo.name,
          repo: repo.html_url,
          path: item.path,
          sha: item.sha,
          engine,
          query,
        });
        newNames.add(repoNameKey);
      }
    }

    if (items.length < searchPerPage) {
      break;
    }

    await sleep(searchDelayMs);
  }
}

const additions = [];
for (const candidate of candidates.values()) {
  const blob = await githubRequest(`/repos/${encodeURIComponent(candidate.owner)}/${encodeURIComponent(candidate.name)}/git/blobs/${candidate.sha}`);
  const html = Buffer.from(blob.content, blob.encoding).toString("utf8");
  const validation = validateCandidateHtml(html, candidate.engine);

  if (!validation.valid) {
    continue;
  }

  additions.push({
    id: makeEntryId(candidate.owner, candidate.name),
    title: extractTitle(html) || candidate.name,
    repo: candidate.repo,
    owner: candidate.owner,
    name: candidate.name,
    engine: candidate.engine,
    status: "indexed",
    discoveredAt: now,
    source: "github-code-search",
    sourcePath: candidate.path,
  });
}

const merged = markDuplicateRepositoryNames([...list, ...additions]);
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

function validateCandidateHtml(html, engine) {
  const lower = html.toLowerCase();
  const core = engine === "RPG Maker MZ" ? "rmmz_core.js" : "rpg_core.js";

  if (!lower.includes(core)) {
    return { valid: false };
  }

  if (!lower.includes("js/main.js") && !lower.includes("js/plugins.js")) {
    return { valid: false };
  }

  return { valid: true };
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

function markDuplicateRepositoryNames(entries) {
  const seenNames = new Set();

  return entries.map((entry) => {
    const nameKey = String(entry.name).toLowerCase();

    if (seenNames.has(nameKey)) {
      return cleanObject({
        ...entry,
        status: entry.status === "invalid_structure" ? entry.status : "duplicate_name",
        duplicateReason: "Repository name already exists in list.json.",
      });
    }

    seenNames.add(nameKey);
    return entry.status === "duplicate_name"
      ? cleanObject({ ...entry, status: undefined, duplicateReason: undefined })
      : entry;
  });
}

async function githubRequest(path, options = {}) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
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

    if (response.ok) {
      return data;
    }

    if (![403, 429].includes(response.status) || attempt === 4) {
      throw new Error(`GitHub API ${response.status}: ${data?.message || response.statusText}`);
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

function cleanObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""));
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

function shortHash(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 8);
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
