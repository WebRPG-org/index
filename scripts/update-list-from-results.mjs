import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const resultsDir = process.env.RESULTS_DIR || "workflow-results";
const listPath = process.env.LIST_PATH || "list.json";
const dryRun = parseBoolean(process.env.DRY_RUN, true);
const now = new Date().toISOString();

const list = JSON.parse(await fs.readFile(listPath, "utf8"));
const results = await readResults(resultsDir);
const resultsByForkName = new Map(results.map((result) => [String(result.forkName || result.repoName).toLowerCase(), result]));
const forkNameBySource = getUniqueSources(list);

let verified = 0;
let invalid = 0;
let skipped = 0;
let errors = 0;
let unchanged = 0;

const updated = list.map((entry) => {
  const sourceKey = `${entry.owner}/${entry.name}`.toLowerCase();
  const forkName = forkNameBySource.get(sourceKey);
  const result = resultsByForkName.get(String(forkName).toLowerCase());

  if (!result) {
    unchanged += 1;
    return entry;
  }

  if (result.status === "verified") {
    verified += 1;

    // If the result has a sourceRepo (original upstream repository),
    // update the repo/owner/name fields so "Source" link points to
    // the original author, not the fork under WebRPG-org.
    const sourceRepo = result.sourceRepo || "";
    const fixedRepo = sourceRepo ? `https://github.com/${sourceRepo}` : entry.repo;
    const fixedOwner = sourceRepo ? sourceRepo.split("/")[0] : entry.owner;
    const fixedName = sourceRepo ? sourceRepo.split("/")[1] : entry.name;

    return cleanObject({
      ...entry,
      status: "verified",
      checkedAt: result.checkedAt || now,
      forkName,
      pagesUrl: result.pagesUrl,
      entryPath: result.entryPath,
      engine: result.engine || entry.engine,
      cover: result.cover || undefined,
      validationScore: result.validationScore,
      totalSize: result.totalSize,
      dataSize: result.dataSize,
      repo: fixedRepo,
      owner: fixedOwner,
      name: fixedName,
      sourceRepo,
    });
  }

  if (result.status === "invalid_structure") {
    invalid += 1;
    return cleanObject({
      ...entry,
      status: "invalid_structure",
      checkedAt: result.checkedAt || now,
      forkName,
      invalidReason: result.invalidReason,
      deletedAt: result.deletedAt || entry.deletedAt,
      cover: undefined,
      pagesUrl: undefined,
      entryPath: undefined,
      validationScore: result.validationScore,
    });
  }

  if (result.status === "skipped_large") {
    skipped += 1;
    return cleanObject({
      ...entry,
      status: "skipped_large",
      checkedAt: result.checkedAt || now,
      forkName,
      invalidReason: result.invalidReason,
      lastCheckError: undefined,
    });
  }

  errors += 1;
  return cleanObject({
    ...entry,
    checkedAt: result.checkedAt || now,
    forkName,
    lastCheckError: result.error || result.invalidReason || `Unexpected status: ${result.status}`,
  });
});

updated.sort((left, right) => left.title.localeCompare(right.title, "zh-Hans") || left.repo.localeCompare(right.repo, "en"));

if (!dryRun) {
  await fs.writeFile(listPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
}

console.log(`Results read: ${results.length}`);
console.log(`Verified entries: ${verified}`);
console.log(`Invalid entries: ${invalid}`);
console.log(`Skipped large entries: ${skipped}`);
console.log(`Error entries: ${errors}`);
console.log(`Unchanged entries: ${unchanged}`);
console.log(`Dry run: ${dryRun}`);

await writeStepSummary([
  "# Update list.json from fork checks",
  "",
  `Results read: \`${results.length}\``,
  `Verified entries: \`${verified}\``,
  `Invalid entries: \`${invalid}\``,
  `Skipped large entries: \`${skipped}\``,
  `Error entries: \`${errors}\``,
  `Unchanged entries: \`${unchanged}\``,
  `Dry run: \`${dryRun}\``,
]);

async function readResults(dir) {
  const files = await listJsonFiles(dir);
  const results = [];

  for (const file of files) {
    results.push(JSON.parse(await fs.readFile(file, "utf8")));
  }

  return results;
}

async function listJsonFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listJsonFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(fullPath);
    }
  }

  return files;
}

function getUniqueSources(entries) {
  const bySource = new Map();

  for (const entry of entries) {
    const source = `${entry.owner}/${entry.name}`;
    const sourceKey = source.toLowerCase();

    if (!bySource.has(sourceKey)) {
      bySource.set(sourceKey, {
        source,
        owner: entry.owner,
        name: entry.name,
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

  return new Map([...bySource.values()].map((item) => [item.source.toLowerCase(), item.forkName]));
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

function cleanObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""));
}

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === "") {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function shortHash(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 8);
}

async function writeStepSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) {
    return;
  }

  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}
