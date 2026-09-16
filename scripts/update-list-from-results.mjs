import fs from "node:fs/promises";
import { getForkNames, getUniqueSources, listJsonFiles, readForkFailures, readForkRecords, sourceKey } from "./repo-identity.mjs";
import { isPlanSkipped, isTerminalStatus } from "./repo-status.mjs";
import { DERIVED_FIELDS, normalizeEntry } from "./normalize-list.mjs";

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
const clearedDerivedFields = Object.fromEntries(DERIVED_FIELDS.map((field) => [field, undefined]));

const list = JSON.parse(await fs.readFile(listPath, "utf8")).map(normalizeEntry);
const results = await readResults(resultsDir);
const planPath = process.env.PLAN_PATH || "workflow-plan/plan.json";
const plan = JSON.parse(await fs.readFile(planPath, "utf8").catch((error) => {
  if (error.code === "ENOENT" && !process.env.PLAN_PATH) return '{"targets":[]}';
  throw error;
}));
const resultsByEntryId = new Map(results.filter((result) => result.entryId).map((result) => [result.entryId, result]));
const resultsByForkName = new Map(results.filter((result) => !result.entryId).map((result) => [String(result.forkName || result.repoName).toLowerCase(), result]));
const plansByEntryId = new Map((plan.targets || []).map((target) => [target.entryId, target]));
const forkRecords = await readForkRecords(forkFailuresDir);
const forkNameBySource = getForkNames(list, forkRecords);
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
for (const item of getUniqueSources(list, forkRecords).sort((a, b) => Number(isPlanSkipped(a.entry)) - Number(isPlanSkipped(b.entry)))) {
  const key = item.forkName.toLowerCase();
  if (!forkOwners.has(key)) forkOwners.set(key, item.entryId);
}

const updated = list.map((entry) => {
  const key = sourceKey(entry);
  if (isTerminalStatus(entry) && entry.status !== "hidden") {
    unchanged += 1;
    return entry;
  }
  let forkName = forkNameBySource.get(key) || entry.forkName || "";
  let forkKey = String(forkName).toLowerCase();
  const target = plansByEntryId.get(entry.id);
  let result = resultsByEntryId.get(entry.id) || resultsByForkName.get(forkKey);
  if (result && ((target && String(result.forkName || result.repoName).toLowerCase() !== target.repo.toLowerCase()) || (result.indexedSource && result.indexedSource.toLowerCase() !== key) || (result.entryId && result.entryId !== entry.id))) result = undefined;
  if (!result && target && (!target.indexedSource || target.indexedSource.toLowerCase() === key)) {
    result = { status: "check_error", entryId: entry.id, forkName: target.repo, indexedSource: key, checkedAt: plan.checkedAt || now, failureKind: "transient", error: "The planned job produced no result; checkout, token creation, processing, or artifact upload failed." };
  }
  if (result) forkName = result.forkName || result.repoName || forkName;
  forkKey = String(forkName).toLowerCase();
  const checkedAt = (result && result.checkedAt) || now;

  if (forkKey) {
    const owner = forkOwners.get(forkKey);

    if (owner === undefined) {
      forkOwners.set(forkKey, entry.id);
    } else if (owner !== entry.id) {
      duplicates += 1;

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
  const forkFailure = forkFailuresBySource.get(key);

  if (forkFailure && forkFailure.kind === "permanent" && !result && !forkRecords.has(key)) {
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
    const fork = forkRecords.get(key);
    return fork ? { ...entry, forkName: fork.forkName, plannedForkName: undefined } : entry;
  }

  if (result.status === "verified") {
    verified += 1;

    // The index identity stays stable. Upstream metadata must not turn an
    // entry for a modified fork into a different source repository.
    const sourceRepo = result.sourceRepo || "";

    return cleanObject({
      ...entry,
      status: "verified",
      checkedAt,
      forkName,
      pagesUrl: result.pagesUrl,
      entryPath: result.entryPath,
      projectRoot: result.projectRoot,
      coverPath: result.coverPath,
      plannedForkName: undefined,
      invalidReason: undefined,
      duplicateReason: undefined,
      deletedAt: undefined,
      reachable: result.reachable,
      reachabilityDetail: result.reachabilityDetail,
      verificationDeferred: result.verificationDeferred || undefined,
      engine: result.engine || entry.engine,
      cover: result.cover || undefined,
      validationScore: result.validationScore,
      totalSize: result.totalSize,
      dataSize: result.dataSize,
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
}).map((entry) => cleanObject(normalizeEntry(entry)));

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

async function writeStepSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) {
    return;
  }

  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}
