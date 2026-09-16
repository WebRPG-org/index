import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { getForkNames, sourceKey } from "./repo-identity.mjs";
import { detectRpgMakerProject, flattenEntries, getStartupScripts, looksLikeRpgMakerEntry, resolveRepoReference, runtimeFiles, DATABASE_FILES, validateEntry } from "./rpgmaker-project.mjs";

const apiBase = "https://api.github.com";
const token = process.env.WEBRPG_APP_TOKEN || process.env.GITHUB_TOKEN || "";
const targetOrg = process.env.TARGET_ORG || "WebRPG-org";
const repoName = process.env.REPO_NAME || "";
const dryRun = parseBoolean(process.env.DRY_RUN, true);
const deleteInvalidRepos = parseBoolean(process.env.DELETE_INVALID_REPOS, true);
const siteOrigin = (process.env.SITE_ORIGIN || "https://webrpg.org").replace(/\/+$/, "");
const resultDir = process.env.RESULT_DIR || "workflow-results";
const scriptTag = process.env.ANALYTICS_SCRIPT_TAG
  || '<script defer src="https://insight.ravelloh.com/script.js?siteId=5ace6623-f51b-4571-8f60-e0473ea3317b"></script>';
const scriptNeedle = getScriptNeedle(scriptTag);
const htmlMaxBytes = parsePositiveInt(process.env.HTML_MAX_BYTES || "1048576");
const maxRepoSizeKb = parseNonNegativeInt(process.env.MAX_REPO_SIZE_KB || "8388608");
const maxTreeEntries = parseNonNegativeInt(process.env.MAX_TREE_ENTRIES || "20000");
const maxHtmlFiles = parseNonNegativeInt(process.env.MAX_HTML_FILES || "500");
const maxHtmlTotalBytes = parseNonNegativeInt(process.env.MAX_HTML_TOTAL_BYTES || "52428800");
const verifyDeployment = parseBoolean(process.env.VERIFY_DEPLOYMENT, true);
const reachabilityTimeoutMs = parsePositiveInt(process.env.REACHABILITY_TIMEOUT_MS || "15000");

const CHALLENGE_MARKERS = [
  "just a moment",
  "attention required",
  "enable javascript and cookies",
  "challenges.cloudflare.com",
  "cf-mitigated",
];

if (!token) {
  throw new Error("WEBRPG_APP_TOKEN or GITHUB_TOKEN is required.");
}

if (!repoName) {
  throw new Error("REPO_NAME is required.");
}

class GitHubApiError extends Error {
  constructor(status, message) {
    super(`GitHub API ${status}: ${message}`);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

// Decide whether another attempt could plausibly succeed.
//
// Rate limits, server errors and lost ref races recover on their own. A deleted
// repository, a missing App permission or a payload the API refuses will fail
// the same way every time, so those entries are retired instead of being
// re-checked forever.
function classifyFailure(error) {
  const status = error instanceof GitHubApiError ? error.status : 0;

  if (status === 404) {
    return "permanent";
  }

  if (status === 403 || status === 429) {
    return /rate limit|abuse|secondary|submitted too quickly|try again later/i.test(error.message)
      ? "transient"
      : "permanent";
  }

  if (status === 422) {
    // A ref race can be won on the next attempt; a rejected payload cannot.
    return /not a fast forward/i.test(error.message) ? "transient" : "permanent";
  }

  return "transient";
}

const checkedAt = new Date().toISOString();
const result = {
  checkedAt,
  dryRun,
  targetOrg,
  repoName,
  forkName: repoName,
  entryId: process.env.INDEX_ENTRY_ID || undefined,
  indexedSource: process.env.INDEXED_SOURCE || undefined,
  status: "check_error",
};

const summary = [];
summary.push(`# Prepare ${targetOrg}/${repoName}`);
summary.push("");
summary.push(`Dry run: \`${dryRun}\``);

try {
  await run();
} catch (error) {
  result.status = "check_error";
  result.error = error.message;
  result.failureKind = classifyFailure(error);
  console.log(`[error] ${targetOrg}/${repoName}: ${error.message}`);
  summary.push(`Status: \`check_error\``);
  summary.push(`Failure kind: \`${result.failureKind}\``);
  summary.push(`Error: ${error.message}`);
}

await writeResult(result);
await writeStepSummary(summary);

async function run() {
  const repo = await githubRequest(`/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}`);
  result.repoUrl = repo.html_url;
  result.defaultBranch = repo.default_branch;
  result.isFork = Boolean(repo.fork);
  result.sourceRepo = repo.parent?.full_name || repo.source?.full_name || null;

  // Repository size is checked after resolving the upstream repository below.

  // Check if this repo is manually hidden in list.json
  const list = JSON.parse(await fs.readFile("list.json", "utf8"));
  const forkNames = getForkNames(list);
  const entry = result.entryId
    ? list.find((item) => item.id === result.entryId)
    : list.find((item) => forkNames.get(sourceKey(item)).toLowerCase() === repoName.toLowerCase() && item.status !== "duplicate_name");
  if (!entry || (result.indexedSource && sourceKey(entry) !== result.indexedSource.toLowerCase())) {
    throw new Error(`No matching index entry for ${targetOrg}/${repoName}.`);
  }
  result.entryId = entry.id;
  result.indexedSource = sourceKey(entry);
  if (entry && entry.status === "hidden") {
    result.status = "hidden";
    result.invalidReason = "Manually hidden via list.json.";
    console.log(`[hidden] ${targetOrg}/${repoName} is manually hidden`);
    summary.push(`Status: \`hidden\``);
    if (!dryRun && deleteInvalidRepos && result.sourceRepo) {
      await githubRequest(`/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}`, {
        method: "DELETE",
        ok: [204],
      });
      result.deleted = true;
      result.deletedAt = new Date().toISOString();
      console.log(`[deleted] ${targetOrg}/${repoName}`);
    }
    return;
  }

  // A repository listed in the index is ours whether or not GitHub still
  // reports it as a fork. The flag disappears when the upstream is deleted,
  // made private or transferred away, and those repositories used to drop out
  // of the pipeline for good while still holding the only copy of the game.
  // They are validated in place instead, with nothing to synchronize from.
  let sourceRepo = result.sourceRepo;
  let upstream = null;
  let upstreamPath = null;

  if (sourceRepo) {
    const [sourceOwner, sourceName] = sourceRepo.split("/");
    if (!sourceOwner || !sourceName) {
      throw new Error(`Invalid upstream repository name: ${sourceRepo}`);
    }

    upstreamPath = `/repos/${encodeURIComponent(sourceOwner)}/${encodeURIComponent(sourceName)}`;

    try {
      upstream = await githubRequest(upstreamPath);
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 404) {
        throw error;
      }

      console.log(`[detached] Upstream ${sourceRepo} is gone; validating ${targetOrg}/${repoName} in place`);
      upstream = null;
      upstreamPath = null;
      sourceRepo = null;
      result.sourceRepo = null;
    }
  }

  let sourceHeadSha = null;

  if (upstream) {
    const sourceDefaultBranch = upstream.default_branch;
    const sourceRef = await githubRequest(
      `${upstreamPath}/git/ref/heads/${encodeGitRefPath(sourceDefaultBranch)}`,
    );
    sourceHeadSha = sourceRef.object.sha;
    result.sourceDefaultBranch = sourceDefaultBranch;
    result.sourceHeadSha = sourceHeadSha;
    result.sourceSize = upstream.size || 0;

    if (upstream.size > maxRepoSizeKb) {
      skipLargeRepository(`Upstream repository size ${upstream.size} KB exceeds the ${maxRepoSizeKb} KB limit.`);
      return;
    }
  } else {
    result.detached = true;
    console.log(`[detached] ${targetOrg}/${repoName} has no upstream; validating in place`);
    summary.push("Upstream: `none` — validating the repository in place.");
  }

  const branch = repo.default_branch;
  let ref = await githubRequest(`/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}/git/ref/heads/${encodeGitRefPath(branch)}`);
  let headSha = ref.object.sha;

  if (sourceHeadSha) {
    const processedSourceSha = entry?.sourceHeadSha;
    const sourceChanged = processedSourceSha !== sourceHeadSha;
    const needsSourceReset = sourceChanged && headSha !== sourceHeadSha;

    if (needsSourceReset && !dryRun) {
      await resetForkToSource(branch, sourceHeadSha);
      result.syncedFromSource = true;
      result.sourceReset = true;
      console.log(`[sync] Reset ${targetOrg}/${repoName} to ${sourceRepo}@${sourceHeadSha.slice(0, 8)}`);
      ref = await githubRequest(`/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}/git/ref/heads/${encodeGitRefPath(branch)}`);
      headSha = ref.object.sha;
    } else if (needsSourceReset) {
      result.sourceReset = false;
      result.syncPending = true;
      console.log(`[dry-run] Would reset ${targetOrg}/${repoName} to ${sourceRepo}@${sourceHeadSha.slice(0, 8)}`);
    }

    if (sourceChanged) {
      summary.push(`Upstream: \`${sourceRepo}@${sourceHeadSha.slice(0, 12)}\``);
    }

    if (result.syncedFromSource) {
      summary.push("Synchronized fork from upstream and discarded previous generated changes.");
    }
  }

  const headCommit = await githubRequest(`/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}/git/commits/${headSha}`);
  const tree = await githubRequest(
    `/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}/git/trees/${headCommit.tree.sha}?recursive=1`,
  );

  if (tree.truncated) {
    skipLargeRepository("GitHub returned a truncated recursive tree.");
    return;
  }

  if (tree.tree.length > maxTreeEntries) {
    skipLargeRepository(`Repository tree has ${tree.tree.length} entries, exceeding the ${maxTreeEntries} entry limit.`);
    return;
  }

  const files = tree.tree.filter((item) => item.type === "blob");
  const htmlFiles = files
    .filter((item) => item.path.toLowerCase().endsWith(".html"))
    .filter((item) => !shouldSkipPath(item.path))
    .filter((item) => item.size <= htmlMaxBytes)
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  const htmlTotalBytes = htmlFiles.reduce((sum, file) => sum + (file.size || 0), 0);

  if (htmlFiles.length > maxHtmlFiles) {
    skipLargeRepository(`Repository has ${htmlFiles.length} HTML files, exceeding the ${maxHtmlFiles} file limit.`);
    return;
  }

  if (htmlTotalBytes > maxHtmlTotalBytes) {
    skipLargeRepository(`HTML files total ${htmlTotalBytes} bytes, exceeding the ${maxHtmlTotalBytes} byte limit.`);
    return;
  }

  const htmlByPath = await loadHtmlContents(htmlFiles);
  const mainFiles = files.filter((file) => /(?:^|\/)js\/main\.js$/i.test(file.path));
  if (mainFiles.length > maxHtmlFiles || mainFiles.some((file) => file.size > htmlMaxBytes)) {
    skipLargeRepository("Startup scripts exceed the inspection limits.");
    return;
  }
  const mainByPath = await loadHtmlContents(mainFiles);
  const detection = detectRpgMakerProject(files, htmlByPath, mainByPath);

  result.htmlFileCount = htmlFiles.length;
  result.validationScore = detection.score;
  result.validationSignals = detection.signals;

  if (!detection.valid) {
    result.status = "invalid_structure";
    result.invalidReason = detection.reason;
    summary.push(`Status: \`invalid_structure\``);
    summary.push(`Reason: ${detection.reason}`);
    console.log(`[invalid] ${targetOrg}/${repoName}: ${detection.reason}`);

    if (!dryRun && deleteInvalidRepos && sourceRepo) {
      await githubRequest(`/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}`, {
        method: "DELETE",
        ok: [204],
      });
      result.deleted = true;
      result.deletedAt = new Date().toISOString();
      console.log(`[deleted] ${targetOrg}/${repoName}`);
    } else if (!dryRun && deleteInvalidRepos) {
      // Without an upstream there is nothing to re-fork from, so the repository
      // may be the only copy of whatever it holds. Keep it.
      result.deleted = false;
      result.keepReason = "No upstream to recover from; the repository may be the only copy.";
      console.log(`[keep] ${targetOrg}/${repoName} has no upstream; keeping the repository`);
    } else {
      result.deleted = false;
      console.log(`[dry-run] Would delete ${targetOrg}/${repoName}`);
    }

    return;
  }

  result.status = "verified";
  result.engine = detection.engine;
  result.entryPath = detection.entryPath;
  result.projectRoot = detection.projectRoot;
  result.pagesUrl = getPagesUrl();

  // Flatten: if projectRoot is a subdirectory, move its contents to repo root
  let currentHeadSha = headSha;
  let currentTree = tree;
  let currentFiles = files;

  if (detection.projectRoot && detection.entryPath.toLowerCase().startsWith(detection.projectRoot.toLowerCase()) && !dryRun) {
    const flat = await flattenProjectToRoot(branch, currentHeadSha, currentTree, detection.projectRoot);
    if (flat) {
      currentHeadSha = flat.headSha;
      // Re-fetch tree after flattening
      const newCommit = await githubRequest(`/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}/git/commits/${currentHeadSha}`);
      currentTree = await githubRequest(`/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}/git/trees/${newCommit.tree.sha}?recursive=1`);
      if (currentTree.truncated) throw new Error("The flattened tree could not be read completely.");
      currentFiles = currentTree.tree.filter((item) => item.type === "blob");
      // Read the moved files from the new tree, rather than looking up a new
      // path in the old map (which can contain an unrelated root homepage).
      const movedHtml = currentFiles.filter((item) => item.path.toLowerCase().endsWith(".html") && !shouldSkipPath(item.path) && item.size <= htmlMaxBytes);
      htmlByPath.clear();
      for (const [filePath, content] of await loadHtmlContents(movedHtml)) htmlByPath.set(filePath, content);
      const movedMain = currentFiles.filter((item) => /(?:^|\/)js\/main\.js$/i.test(item.path));
      mainByPath.clear();
      for (const [filePath, content] of await loadHtmlContents(movedMain)) mainByPath.set(filePath, content);

      // Update detection paths — projectRoot is now empty
      const prefix = detection.projectRoot;
      detection.projectRoot = "";
      detection.entryPath = stripProjectRoot(detection.entryPath, prefix);
      detection.htmlPathsToPatch = detection.htmlPathsToPatch.map((p) => stripProjectRoot(p, prefix));
      result.projectRoot = "";
      result.entryPath = detection.entryPath;
      result.flattened = true;
      console.log(`[flatten] Project moved to root, new entry: ${detection.entryPath}`);
    }
  }

  result.pagesUrl = detection.entryPath === "index.html" ? getPagesUrl() : pathToPagesUrl(detection.entryPath);
  const preparedValidation = validateEntry({ html: htmlByPath.get(detection.entryPath), mainContent: mainByPath.get(`${detection.projectRoot}js/main.js`) || "", engine: detection.engine, entryPath: detection.entryPath, projectRoot: detection.projectRoot, files: currentFiles });
  if (!preparedValidation.valid) throw new Error(`Prepared entry is invalid: ${preparedValidation.reason}`);

  // Compute game size metrics (zero additional API cost)
  result.totalSize = (upstream ? upstream.size : repo.size) || 0;
  const dataSize = currentFiles
    .filter((f) => f.path.startsWith(`${detection.projectRoot}data/`) && f.path.endsWith(".json"))
    .reduce((sum, f) => sum + (f.size || 0), 0);
  result.dataSize = dataSize;

  const updates = new Map();

  // Check if a cover image already exists in the repo root
  const existingCoverFile = currentTree.tree.find(
    (item) => item.type === "blob" && /^cover\.(png|jpg|jpeg|webp)$/i.test(item.path),
  );
  if (existingCoverFile) {
    result.cover = `${getPagesUrl()}${existingCoverFile.path}`;
    result.coverPath = existingCoverFile.path;
    console.log(`[cover] Already exists: ${existingCoverFile.path}, skipping cover search`);
  } else {
    const coverResult = findCover(currentFiles, detection.projectRoot);
    if (coverResult) {
      result.cover = coverResult.pagesUrl;
      result.coverPath = coverResult.coverPath;

      // Skip oversized cover images (> 5MB) — GitHub blob API rejects very large files
      const MAX_COVER_SIZE = 5 * 1024 * 1024;
      if (coverResult.coverFile.size > MAX_COVER_SIZE) {
        console.log(`[cover] Skipping ${coverResult.coverPath}: ${coverResult.coverFile.size} bytes exceeds ${MAX_COVER_SIZE} limit`);
        result.cover = null;
        result.coverPath = undefined;
      } else if (coverResult.needsDecrypt) {
        try {
          const pngBuffer = await decryptRpgmvp(targetOrg, repoName, coverResult.coverFile.sha);
          if (pngBuffer.length > MAX_COVER_SIZE) {
            result.cover = null;
            result.coverPath = undefined;
            console.log(`[cover] Skipping decrypted cover: ${pngBuffer.length} bytes exceeds limit`);
          } else {
            result.coverPngBuffer = pngBuffer;
            console.log(`[cover] Will commit cover.png (${pngBuffer.length} bytes) from ${coverResult.coverPath}`);
          }
        } catch (error) {
          result.cover = null;
          result.coverPath = undefined;
          console.log(`[cover] Failed to decrypt ${coverResult.coverPath}: ${error.message}`);
        }
      } else {
        // Unencrypted image — commit the original blob as cover.png
        try {
          const blob = await githubRequest(
            `/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}/git/blobs/${coverResult.coverFile.sha}`,
          );
          const imgBuffer = Buffer.from(blob.content, blob.encoding);
          if (imgBuffer.length > MAX_COVER_SIZE) {
            console.log(`[cover] Skipping ${coverResult.coverPath}: ${imgBuffer.length} bytes exceeds limit`);
          } else {
            result.coverPngBuffer = imgBuffer;
            console.log(`[cover] Will copy ${coverResult.coverPath} as cover.png (${imgBuffer.length} bytes)`);
          }
        } catch (error) {
          result.cover = null;
          result.coverPath = undefined;
          console.log(`[cover] Failed to read ${coverResult.coverPath}: ${error.message}`);
        }
      }
    } else {
      result.cover = null;
    }
  }

  for (const filePath of detection.htmlPathsToPatch) {
    const original = htmlByPath.get(filePath);
    if (original === undefined) {
      continue;
    }

    const updated = injectScript(original, scriptTag, scriptNeedle);
    if (updated !== original) {
      updates.set(filePath, updated);
    }
  }

  if (dryRun) {
    console.log(`[dry-run] Valid ${detection.engine} project at ${detection.entryPath}`);
    console.log(`[dry-run] Would update ${updates.size} HTML files.`);
    console.log(`[dry-run] Would enable GitHub Pages from ${branch}/.`);
    result.htmlFilesUpdated = updates.size;
    result.processedHeadSha = currentHeadSha;
    result.pagesEnabled = false;
    summary.push(`Status: \`verified\``);
    summary.push(`Engine: \`${detection.engine}\``);
    summary.push(`Entry: \`${detection.entryPath}\``);
    if (result.flattened) {
      summary.push(`Flattened: \`true\``);
    }
    summary.push(`Cover: \`${result.cover || "none"}\``);
    summary.push(`HTML files to update: \`${updates.size}\``);
    summary.push(`Pages URL: \`${result.pagesUrl}\``);
    return;
  }

  // If a cover was found and needs to be committed as cover.png
  if (result.coverPngBuffer && !dryRun) {
    // Check if cover.png already exists with the same content
    const existingCover = currentTree.tree.find(
      (item) => item.path === "cover.png" && item.type === "blob",
    );
    const newSha = crypto.createHash("sha1").update(`blob ${result.coverPngBuffer.length}\0`).update(result.coverPngBuffer).digest("hex");
    if (existingCover && existingCover.sha === newSha) {
      console.log(`[cover] cover.png unchanged, skipping`);
    } else {
      updates.set("cover.png", result.coverPngBuffer);
      result.cover = `${getPagesUrl()}cover.png`;
      result.coverPath = "cover.png";
      console.log(`[cover] ${existingCover ? "Updated" : "Added"} cover.png`);
    }
  }

  if (updates.size > 0) {
    const prepared = await commitHtmlUpdates({
      branch,
      baseCommitSha: currentHeadSha,
      baseTreeSha: currentTree.sha || currentHeadSha,
      updates,
    });
    currentHeadSha = prepared.headSha;
    const fileTypes = [...updates.keys()].map((k) => k.endsWith(".png") ? "cover.png" : k).join(", ");
    console.log(`[updated] ${updates.size} file(s) in ${targetOrg}/${repoName}: ${fileTypes}`);
  } else {
    console.log(`[skip] HTML already prepared in ${targetOrg}/${repoName}`);
  }

  const pagesSetup = await ensurePages(branch, "/");
  result.htmlFilesUpdated = updates.size;
  result.processedHeadSha = currentHeadSha;
  result.pagesEnabled = true;

  // Structural validation only proves the files exist. Confirm that the site
  // actually serves the game — but only for a deployment that was already live
  // before this run, since a fresh one has not propagated yet. Marking a
  // working game as broken would be worse than a late check.
  const deploymentChanged = updates.size > 0 || pagesSetup.created || result.flattened || result.sourceReset;

  if (!verifyDeployment) {
    result.verificationDisabled = true;
  } else if (deploymentChanged) {
    result.verificationDeferred = true;
  } else {
    const verdict = await verifyDeployedEntry(detection, currentFiles);
    result.reachable = verdict.ok;
    result.reachabilityDetail = verdict.reason;

    if (verdict.ok) {
      console.log(`[verify] ${result.pagesUrl} serves the game`);
    } else if (verdict.definitive) {
      throw new Error(`Deployed entry is not reachable: ${verdict.reason}`);
    } else {
      console.log(`[verify] inconclusive for ${targetOrg}/${repoName}: ${verdict.reason}`);
    }
  }
  summary.push(`Status: \`verified\``);
  summary.push(`Engine: \`${detection.engine}\``);
  summary.push(`Entry: \`${detection.entryPath}\``);
  if (result.flattened) {
    summary.push(`Flattened: \`true\``);
  }
  summary.push(`Cover: \`${result.cover || "none"}\``);
  summary.push(`HTML files updated: \`${updates.size}\``);
  summary.push(`Pages URL: \`${result.pagesUrl}\``);
  if (result.verificationDeferred) {
    summary.push("Deployment verification: `deferred to the next run`");
  }
  if (result.reachable !== undefined) {
    summary.push(`Deployment reachable: \`${result.reachable}\``);
  }
}

// Markers a CDN uses on a challenge page. The site sits behind Cloudflare,
// whose challenges are served with HTTP 200, so a content mismatch alone cannot
// tell a broken game apart from a blocked request.

function looksLikeBotChallenge(response, body) {
  if (response.headers.get("cf-mitigated")) {
    return true;
  }

  const lower = String(body || "").toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => lower.includes(marker));
}

// Fetch the deployed entry point and make sure it really is the game. Returns
// `definitive: false` whenever the answer says more about the network than
// about the deployment, so a blocked or overloaded request cannot retire an
// entry that is working.
async function fetchDeployment(url, method = "GET") {
  try {
    const response = await fetch(url, {
      method,
      headers: { "User-Agent": "WebRPG-index/1.0", Accept: "*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(reachabilityTimeoutMs),
    });
    const body = method === "HEAD" ? "" : await response.text();
    if (looksLikeBotChallenge(response, body)) return { ok: false, definitive: false, reason: `${url} answered with a bot challenge` };
    if (!response.ok) return { ok: false, definitive: [404, 410].includes(response.status), reason: `${url} responded with HTTP ${response.status}` };
    return { ok: true, response, body };
  } catch (error) {
    return { ok: false, definitive: false, reason: `${url} could not be fetched: ${error.message}` };
  }
}

async function verifyDeployedEntry(detection, files) {
  // This is the public link written to list.json, including non-index entries.
  const url = result.pagesUrl;
  const entry = await fetchDeployment(url);
  if (!entry.ok) return entry;
  if (!looksLikeRpgMakerEntry(entry.body, detection.engine)) return { ok: false, definitive: true, reason: `${url} served a page without an RPG Maker entry point` };
  const mainPath = `${detection.projectRoot}js/main.js`;
  const main = await fetchDeployment(pathToPagesUrl(mainPath));
  if (!main.ok) return main;
  const validation = validateEntry({ html: entry.body, mainContent: main.body, engine: detection.engine, entryPath: detection.entryPath, projectRoot: detection.projectRoot, files });
  if (!validation.valid) return { ok: false, definitive: true, reason: `${url}: ${validation.reason}` };
  const system = await fetchDeployment(pathToPagesUrl(`${detection.projectRoot}data/System.json`));
  if (!system.ok) return system;
  try {
    const data = JSON.parse(system.body);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Expected an object");
  } catch {
    return { ok: false, definitive: true, reason: `${url} does not serve valid data/System.json` };
  }
  const { direct, dynamic } = getStartupScripts(entry.body, main.body);
  const resourcePaths = new Set(runtimeFiles(detection.engine).concat(DATABASE_FILES).map((name) => `${detection.projectRoot}${name}`));
  for (const reference of direct.concat(dynamic)) {
    const resolved = resolveRepoReference(detection.entryPath, reference);
    if (resolved) resourcePaths.add(resolved);
  }
  resourcePaths.delete(mainPath);
  resourcePaths.delete(`${detection.projectRoot}data/System.json`);
  for (const resourcePath of resourcePaths) {
    const resource = await fetchDeployment(pathToPagesUrl(resourcePath), "HEAD");
    if (!resource.ok) return resource;
    if (resource.response.headers.get("content-type")?.includes("text/html")) return { ok: false, definitive: true, reason: `${resourcePath} served HTML instead of a game resource` };
  }
  return { ok: true, definitive: true, reason: `${url} served an RPG Maker entry point and its startup resources` };
}

function skipLargeRepository(reason) {
  result.status = "skipped_large";
  result.invalidReason = reason;
  summary.push("Status: `skipped_large`");
  summary.push(`Reason: ${reason}`);
  console.log(`[skip] ${targetOrg}/${repoName}: ${reason}`);
}

async function loadHtmlContents(htmlFiles) {
  const htmlByPath = new Map();

  for (const file of htmlFiles) {
    const blob = await githubRequest(`/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}/git/blobs/${file.sha}`);
    htmlByPath.set(file.path, Buffer.from(blob.content, blob.encoding).toString("utf8"));
  }

  return htmlByPath;
}

// Only the title screens count as a cover. Anything else (the application
// icon, favicons, in-game pictures) is the wrong shape or the wrong image, and
// showing one as a full-size banner is worse than showing nothing.
function findCover(files, projectRoot) {
  const lowerRoot = projectRoot.toLowerCase();
  const imageFiles = files
    .filter((file) => /\.(png|jpe?g|webp|rpgmvp)$/i.test(file.path))
    .filter((file) => !shouldSkipPath(file.path));

  // Priority 1: img/titles1/ directory
  const titles1 = imageFiles.filter((f) => {
    const rel = f.path.toLowerCase().slice(lowerRoot.length);
    return rel.startsWith("img/titles1/");
  }).sort((a, b) => a.path.localeCompare(b.path, "en"));
  if (titles1.length > 0) {
    return {
      coverFile: titles1[0],
      coverPath: titles1[0].path,
      pagesUrl: pathToPagesUrl(titles1[0].path),
      needsDecrypt: titles1[0].path.toLowerCase().endsWith(".rpgmvp"),
    };
  }

  // Priority 2: img/titles2/ directory
  const titles2 = imageFiles.filter((f) => {
    const rel = f.path.toLowerCase().slice(lowerRoot.length);
    return rel.startsWith("img/titles2/");
  }).sort((a, b) => a.path.localeCompare(b.path, "en"));
  if (titles2.length > 0) {
    return {
      coverFile: titles2[0],
      coverPath: titles2[0].path,
      pagesUrl: pathToPagesUrl(titles2[0].path),
      needsDecrypt: titles2[0].path.toLowerCase().endsWith(".rpgmvp"),
    };
  }

  // No titles cover found
  return null;
}

async function decryptRpgmvp(org, repo, fileSha) {
  // Download blob content
  const blob = await githubRequest(
    `/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/git/blobs/${fileSha}`,
  );
  const raw = Buffer.from(blob.content, blob.encoding);

  // RPG Maker MV .rpgmvp format:
  // First 32 bytes: custom header (includes signature, version, flags, dimensions)
  // After 32 bytes: the actual image data with PNG header stripped (first 16 bytes removed)
  // To convert: prepend standard PNG header (16 bytes) + skip first 32 bytes of .rpgmvp

  if (raw.length < 32) {
    throw new Error("Invalid .rpgmvp file: too short");
  }

  const magic = raw.subarray(0, 5).toString();
  if (magic !== "RPGMV") {
    throw new Error(`Invalid .rpgmvp magic: ${magic}`);
  }

  // Standard PNG header bytes
  const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52]);
  const pixelData = Buffer.concat([pngHeader, raw.subarray(32)]);

  // Verify it's a valid PNG
  if (pixelData[0] !== 0x89 || pixelData[1] !== 0x50 || pixelData[2] !== 0x4E || pixelData[3] !== 0x47) {
    throw new Error(`Decrypted data is not a valid PNG (starts with: ${pixelData.subarray(0, 4).toString("hex")})`);
  }

  console.log(`[cover] Decrypted .rpgmvp to PNG (${pixelData.length} bytes)`);
  return pixelData;
}

async function flattenProjectToRoot(branch, headSha, tree, projectRoot) {
  const blobEntries = flattenEntries(tree.tree, projectRoot);

  console.log(`[flatten] Publishing ${blobEntries.length} files with ${projectRoot} moved to the root`);

  // Group by top-level directory for nested tree creation
  const dirGroups = new Map();
  const rootBlobs = [];

  for (const entry of blobEntries) {
    const slash = entry.path.indexOf("/");
    if (slash === -1) {
      rootBlobs.push(entry);
    } else {
      const dir = entry.path.slice(0, slash);
      if (!dirGroups.has(dir)) dirGroups.set(dir, []);
      dirGroups.get(dir).push(entry);
    }
  }

  // Recursively create subtrees for each directory
  const rootEntries = [...rootBlobs];

  for (const [dirName, dirEntries] of dirGroups) {
    const subtreeSha = await createSubtree(dirName + "/", dirEntries);
    rootEntries.push({ path: dirName, sha: subtreeSha, mode: "040000", type: "tree" });
    console.log(`[flatten] Created subtree for ${dirName}/`);
  }

  // Create root tree
  const rootTree = await githubRequest(`/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}/git/trees`, {
    method: "POST",
    body: { tree: rootEntries },
    ok: [201],
  });

  // Create commit
  const newCommit = await githubRequest(`/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}/git/commits`, {
    method: "POST",
    body: {
      message: "Flatten project to root for GitHub Pages",
      tree: rootTree.sha,
      parents: [headSha],
    },
    ok: [201],
  });

  // Update ref
  await githubRequest(`/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}/git/refs/heads/${encodeGitRefPath(branch)}`, {
    method: "PATCH",
    body: { sha: newCommit.sha, force: false },
  });

  console.log(`[flatten] Done, new commit: ${newCommit.sha.slice(0, 8)}`);
  return { headSha: newCommit.sha };
}

async function createSubtree(prefix, entries) {
  const subDirs = new Map();
  const directBlobs = [];

  for (const entry of entries) {
    const rest = entry.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      directBlobs.push({ path: rest, sha: entry.sha, mode: entry.mode, type: "blob" });
    } else {
      const dir = rest.slice(0, slash);
      if (!subDirs.has(dir)) subDirs.set(dir, []);
      subDirs.get(dir).push(entry);
    }
  }

  // Recursively create subtrees for deeper dirs
  for (const [dirName, dirEntries] of subDirs) {
    const subPrefix = `${prefix}${dirName}/`;
    const subtreeSha = await createSubtree(subPrefix, dirEntries);
    directBlobs.push({ path: dirName, sha: subtreeSha, mode: "040000", type: "tree" });
  }

  // Create this level's tree (chunk if > 500 entries)
  const CHUNK_SIZE = 500;
  let result;

  for (let i = 0; i < directBlobs.length; i += CHUNK_SIZE) {
    const chunk = directBlobs.slice(i, i + CHUNK_SIZE);
    if (!result) {
      result = await githubRequest(`/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}/git/trees`, {
        method: "POST",
        body: { tree: chunk },
        ok: [201],
      });
    } else {
      result = await githubRequest(`/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}/git/trees`, {
        method: "POST",
        body: { base_tree: result.sha, tree: chunk },
        ok: [201],
      });
    }
  }

  return result.sha;
}

async function commitHtmlUpdates({ branch, baseCommitSha, baseTreeSha, updates }) {
  const treeEntries = [];

  for (const [filePath, content] of updates) {
    // content can be a string (HTML) or a Buffer (binary, e.g. cover.png)
    const base64Content = Buffer.isBuffer(content)
      ? content.toString("base64")
      : Buffer.from(content, "utf8").toString("base64");

    const blob = await githubRequest(`/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}/git/blobs`, {
      method: "POST",
      body: {
        content: base64Content,
        encoding: "base64",
      },
      ok: [201],
    });
    treeEntries.push({
      path: filePath,
      mode: "100644",
      type: "blob",
      sha: blob.sha,
    });
  }

  const newTree = await githubRequest(`/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}/git/trees`, {
    method: "POST",
    body: {
      base_tree: baseTreeSha,
      tree: treeEntries,
    },
    ok: [201],
  });
  const newCommit = await githubRequest(`/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}/git/commits`, {
    method: "POST",
    body: {
      message: "Prepare WebRPG Pages entry",
      tree: newTree.sha,
      parents: [baseCommitSha],
    },
    ok: [201],
  });
  await githubRequest(`/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}/git/refs/heads/${encodeGitRefPath(branch)}`, {
    method: "PATCH",
    body: {
      sha: newCommit.sha,
      force: false,
    },
  });

  return { headSha: newCommit.sha };
}

function injectScript(content, tag, needle) {
  if (content.includes(needle)) {
    return content;
  }

  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const headMatch = content.match(/^([ \t]*)<\/head>/im);

  if (headMatch?.index !== undefined) {
    const indentedTag = `${headMatch[1]}${tag}`;
    return `${content.slice(0, headMatch.index)}${indentedTag}${newline}${content.slice(headMatch.index)}`;
  }

  const bodyMatch = content.match(/^([ \t]*)<\/body>/im);
  if (bodyMatch?.index !== undefined) {
    const indentedTag = `${bodyMatch[1]}${tag}`;
    return `${content.slice(0, bodyMatch.index)}${indentedTag}${newline}${content.slice(bodyMatch.index)}`;
  }

  const suffix = content.endsWith("\n") ? "" : newline;
  return `${content}${suffix}${tag}${newline}`;
}

async function ensurePages(branch, sourcePath) {
  const current = await githubRequest(`/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}/pages`, {
    ok: [200, 404],
  });

  if (current?.status === 404 || current === null) {
    const created = await githubRequest(`/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}/pages`, {
      method: "POST",
      body: {
        source: {
          branch,
          path: sourcePath,
        },
      },
      ok: [201],
    });
    console.log(`[pages] enabled ${getPagesUrl()}`);
    return { pages: created, created: true };
  }

  const source = current.source || {};
  if (source.branch === branch && source.path === sourcePath) {
    console.log(`[pages] already enabled ${getPagesUrl()}`);
    return { pages: current, created: false };
  }

  await githubRequest(`/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}/pages`, {
    method: "PUT",
    body: {
      source: {
        branch,
        path: sourcePath,
      },
    },
    ok: [204],
  });
  console.log(`[pages] updated ${getPagesUrl()}`);
  return { pages: current, created: true };
}

async function resetForkToSource(branch, sourceHeadSha) {
  await githubRequest(
    `/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}/git/refs/heads/${encodeGitRefPath(branch)}`,
    {
      method: "PATCH",
      body: {
        sha: sourceHeadSha,
        force: true,
      },
      ok: [200],
    },
  );
}

async function githubRequest(apiPath, options = {}) {
  const response = await fetch(`${apiBase}${apiPath}`, {
    method: options.method || "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "WebRPG-index/1.0",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  const data = parseResponseBody(text);
  const ok = options.ok || [200];

  if (ok.includes(response.status)) {
    if (response.status === 404) {
      return { status: 404 };
    }
    return data;
  }

  const message = data?.message || response.statusText;
  throw new GitHubApiError(response.status, message);
}

function shouldSkipPath(repoPath) {
  return /(^|\/)(node_modules|vendor|coverage|\.git|\.github)\//i.test(repoPath);
}

// Remove the project root from a path without String.replace, which would also
// rewrite an identical substring appearing later in the path.
function stripProjectRoot(repoPath, projectRoot) {
  if (!projectRoot) {
    return repoPath;
  }

  return repoPath.toLowerCase().startsWith(projectRoot.toLowerCase())
    ? repoPath.slice(projectRoot.length)
    : repoPath;
}

function encodeGitRefPath(ref) {
  return ref.split("/").map(encodeURIComponent).join("/");
}

function pathToPagesUrl(repoPath) {
  return `${getPagesUrl()}${repoPath.split("/").map(encodeURIComponent).join("/")}`;
}

function getScriptNeedle(tag) {
  const match = tag.match(/src=["']([^"']+)["']/i);
  return match?.[1] || tag;
}

function getPagesUrl() {
  return `${siteOrigin}/${repoName}/`;
}

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === "") {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
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

async function writeResult(data) {
  await fs.mkdir(resultDir, { recursive: true });
  const resultPath = path.join(resultDir, `${repoName}.json`);
  // Strip binary buffer fields before serializing (they can be very large)
  const { coverPngBuffer, ...serializable } = data;
  await fs.writeFile(resultPath, `${JSON.stringify(serializable, null, 2)}\n`, "utf8");
}

async function writeStepSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) {
    return;
  }

  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}
