import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const resultsDir = process.env.RESULTS_DIR || "workflow-results";
const forkFailuresDir = process.env.FORK_FAILURES_DIR || "workflow-failures";
const listPath = process.env.LIST_PATH || "list.json";
const dryRun = parseBoolean(process.env.DRY_RUN, true);
// Consecutive failures tolerated before an entry stops being advertised as
// playable, and before it is retired altogether.
const failureThreshold = parseNonNegativeInt(process.env.FAILURE_THRESHOLD || "3");
const retryLimit = parseNonNegativeInt(process.env.RETRY_LIMIT || "8");
const now = new Date().toISOString();

// Derived metadata only describes a fork that was just verified. Every other
// outcome clears it, otherwise list.json keeps advertising pages, covers and
// entry paths for forks that are no longer prepared.
const clearedDerivedFields = {
  pagesUrl: undefined,
  cover: undefined,
  coverPath: undefined,
  entryPath: undefined,
  projectRoot: undefined,
};

const list = JSON.parse(await fs.readFile(listPath, "utf8"));
const results = await readResults(resultsDir);
const resultsByForkName = new Map(results.map((result) => [String(result.forkName || result.repoName).toLowerCase(), result]));
const forkNameBySource = getForkNames(list);
const forkFailuresBySource = await readForkFailures(forkFailuresDir);
const retired = [];

let verified = 0;
let invalid = 0;
let skipped = 0;
let hidden = 0;
let duplicates = 0;
let errors = 0;
let quarantined = 0;
let unavailable = 0;
let retryExhausted = 0;
let forkFailuresRetired = 0;
let unchanged = 0;

// A single fork can be referenced by several entries (a monorepo exposing more
// than one playable project). Only the first entry owns the fork's result, so
// the others cannot inherit its pages, cover or entry path.
const forkOwners = new Map();

const updated = list.map((entry) => {
  const sourceKey = `${entry.owner}/${entry.name}`.toLowerCase();
  const forkName = forkNameBySource.get(sourceKey) || entry.forkName || "";
  const forkKey = String(forkName).toLowerCase();
  const result = resultsByForkName.get(forkKey);
  const checkedAt = (result && result.checkedAt) || now;

  if (forkKey) {
    const owner = forkOwners.get(forkKey);

    if (owner === undefined) {
      forkOwners.set(forkKey, entry.id);
    } else if (owner !== entry.id) {
      duplicates += 1;

      if (entry.status === "invalid_structure") {
        unchanged += 1;
        return entry;
      }

      return cleanObject({
        ...entry,
        status: "duplicate_name",
        checkedAt: result ? checkedAt : entry.checkedAt,
        forkName,
        duplicateReason: "Another list entry already maps to this fork repository.",
        lastCheckError: undefined,
        consecutiveFailures: undefined,
        lastFailedAt: undefined,
        ...clearedDerivedFields,
        validationScore: undefined,
        totalSize: undefined,
        dataSize: undefined,
      });
    }
  }

  // The fork workflow could not create the repository at all. A source
  // repository that no longer exists will not turn up on a later attempt
  // either, so retire the entry here: until now every run retried the same
  // dead name and the entry stayed `indexed` forever.
  const forkFailure = forkFailuresBySource.get(sourceKey);

  if (forkFailure && forkFailure.kind === "permanent" && !entry.forkName) {
    forkFailuresRetired += 1;
    retired.push(`${entry.title} — unavailable: the source repository could not be forked`);

    return cleanObject({
      ...entry,
      status: "unavailable",
      checkedAt: forkFailure.checkedAt || checkedAt,
      lastCheckError: `Fork creation failed: ${forkFailure.message}`,
      invalidReason: `Fork creation failed: ${forkFailure.message}`,
      consecutiveFailures: (Number(entry.consecutiveFailures) || 0) + 1,
      lastFailedAt: forkFailure.checkedAt || checkedAt,
      ...clearedDerivedFields,
    });
  }

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
      checkedAt,
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
      sourceDefaultBranch: result.sourceDefaultBranch,
      sourceHeadSha: result.sourceHeadSha,
      processedHeadSha: result.processedHeadSha,
      syncedFromSource: result.syncedFromSource || undefined,
      lastCheckError: undefined,
      consecutiveFailures: undefined,
      lastFailedAt: undefined,
    });
  }

  if (result.status === "invalid_structure") {
    invalid += 1;
    return cleanObject({
      ...entry,
      status: "invalid_structure",
      checkedAt,
      forkName,
      invalidReason: result.invalidReason,
      deletedAt: result.deletedAt || entry.deletedAt,
      validationScore: result.validationScore,
      lastCheckError: undefined,
      consecutiveFailures: undefined,
      lastFailedAt: undefined,
      ...clearedDerivedFields,
    });
  }

  if (result.status === "skipped_large") {
    skipped += 1;
    return cleanObject({
      ...entry,
      status: "skipped_large",
      checkedAt,
      forkName,
      invalidReason: result.invalidReason,
      validationScore: result.validationScore,
      lastCheckError: undefined,
      consecutiveFailures: undefined,
      lastFailedAt: undefined,
      ...clearedDerivedFields,
    });
  }

  if (result.status === "hidden") {
    hidden += 1;
    return cleanObject({
      ...entry,
      status: "hidden",
      checkedAt,
      forkName,
      hiddenReason: entry.hiddenReason || "Manually hidden via list.json.",
      lastCheckError: undefined,
      consecutiveFailures: undefined,
      lastFailedAt: undefined,
      ...clearedDerivedFields,
    });
  }

  // not_fork, source_unavailable, check_error and anything unexpected.
  // These carry no usable outcome for the entry, so they are counted and
  // recorded rather than silently preserving the previous state.
  errors += 1;
  const consecutiveFailures = (Number(entry.consecutiveFailures) || 0) + 1;
  const lastCheckError = result.error || result.invalidReason || `Unexpected status: ${result.status}`;
  const failureFields = {
    checkedAt,
    forkName,
    lastCheckError,
    consecutiveFailures,
    lastFailedAt: checkedAt,
  };

  // The check cannot succeed however often it runs: the repository is gone, the
  // App cannot read it, or the request is rejected outright.
  if (result.failureKind === "permanent") {
    unavailable += 1;
    retired.push(`${entry.title} — unavailable: ${lastCheckError}`);
    return cleanObject({
      ...entry,
      ...failureFields,
      status: "unavailable",
      invalidReason: lastCheckError,
      validationScore: undefined,
      totalSize: undefined,
      dataSize: undefined,
      ...clearedDerivedFields,
    });
  }

  // Retries are not free: every attempt spends one of the limited slots of the
  // prepare matrix and some of the GitHub rate limit.
  if (consecutiveFailures >= retryLimit) {
    retryExhausted += 1;
    retired.push(`${entry.title} — retry_exhausted after ${consecutiveFailures} checks: ${lastCheckError}`);
    return cleanObject({
      ...entry,
      ...failureFields,
      status: "retry_exhausted",
      invalidReason: `Gave up after ${consecutiveFailures} consecutive failed checks.`,
      validationScore: undefined,
      totalSize: undefined,
      dataSize: undefined,
      ...clearedDerivedFields,
    });
  }

  // A transient failure must not remove a link that is already verified, but a
  // check that keeps failing has to stop being advertised as playable.
  if (entry.pagesUrl && consecutiveFailures < failureThreshold) {
    return cleanObject({
      ...entry,
      ...failureFields,
    });
  }

  quarantined += 1;
  return cleanObject({
    ...entry,
    ...failureFields,
    status: "check_error",
    validationScore: undefined,
    totalSize: undefined,
    dataSize: undefined,
    ...clearedDerivedFields,
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
console.log(`Hidden entries: ${hidden}`);
console.log(`Duplicate entries: ${duplicates}`);
console.log(`Check errors: ${errors}`);
console.log(`Quarantined entries: ${quarantined}`);
console.log(`Unavailable entries: ${unavailable}`);
console.log(`Retry exhausted entries: ${retryExhausted}`);
console.log(`Entries retired for failing to fork: ${forkFailuresRetired}`);
if (retired.length > 0) {
  console.log("Retired this run:");
  for (const line of retired) {
    console.log(`  - ${line}`);
  }
}
console.log(`Unchanged entries: ${unchanged}`);
console.log(`Dry run: ${dryRun}`);

const summaryLines = [
  "# Update list.json from fork checks",
  "",
  `Results read: \`${results.length}\``,
  `Verified entries: \`${verified}\``,
  `Invalid entries: \`${invalid}\``,
  `Skipped large entries: \`${skipped}\``,
  `Hidden entries: \`${hidden}\``,
  `Duplicate entries: \`${duplicates}\``,
  `Check errors: \`${errors}\``,
  `Quarantined entries (${failureThreshold} consecutive failures): \`${quarantined}\``,
  `Unavailable entries (unrecoverable): \`${unavailable}\``,
  `Retry exhausted entries (${retryLimit} consecutive failures): \`${retryExhausted}\``,
  `Entries retired for failing to fork: \`${forkFailuresRetired}\``,
  `Unchanged entries: \`${unchanged}\``,
  `Dry run: \`${dryRun}\``,
];

// Retiring an entry removes a game from the site, so name every one of them.
if (retired.length > 0) {
  summaryLines.push("", `### Retired this run (${retired.length})`);
  for (const line of retired.slice(0, 30)) {
    summaryLines.push(`- ${line}`);
  }
  if (retired.length > 30) {
    summaryLines.push(`- …and ${retired.length - 30} more`);
  }
}

await writeStepSummary(summaryLines);

async function readResults(dir) {
  const files = await listJsonFiles(dir);
  const results = [];

  for (const file of files) {
    results.push(JSON.parse(await fs.readFile(file, "utf8")));
  }

  return results;
}

// Latest verdict per source repository. A permanent failure is not undone by a
// later transient one, so it wins regardless of order.
async function readForkFailures(dir) {
  const failures = new Map();

  for (const file of await listJsonFiles(dir)) {
    const report = JSON.parse(await fs.readFile(file, "utf8"));

    for (const failure of report.failures || []) {
      const key = String(failure.source || "").toLowerCase();
      if (!failures.has(key) || failure.kind === "permanent") {
        failures.set(key, failure);
      }
    }
  }

  return failures;
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

// Map "owner/name" to the fork repository name. The recorded forkName wins:
// the verified branch rewrites owner/name to the upstream repository, so
// recomputing it from those fields could point at a fork that never existed.
function getForkNames(entries) {
  const bySource = new Map();

  for (const entry of entries) {
    const sourceKey = `${entry.owner}/${entry.name}`.toLowerCase();

    if (bySource.has(sourceKey)) {
      continue;
    }

    bySource.set(sourceKey, {
      source: sourceKey,
      owner: entry.owner,
      name: entry.name,
      forkName: entry.forkName || makeForkName(entry.owner, entry.name),
      computed: !entry.forkName,
    });
  }

  const usedNames = new Map();
  for (const item of bySource.values()) {
    const nameKey = item.forkName.toLowerCase();
    const existingSource = usedNames.get(nameKey);

    if (item.computed && existingSource && existingSource !== item.source) {
      item.forkName = makeForkName(item.owner, `${item.name}-${shortHash(item.source)}`);
    }

    usedNames.set(item.forkName.toLowerCase(), item.source);
  }

  return new Map([...bySource.values()].map((item) => [item.source, item.forkName]));
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

async function writeStepSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) {
    return;
  }

  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}
