import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const apiBase = "https://api.github.com";
const token = process.env.WEBRPG_APP_TOKEN || process.env.GITHUB_TOKEN || "";
const targetOrg = process.env.TARGET_ORG || "WebRPG-org";
const repoName = process.env.REPO_NAME || "";
const dryRun = parseBoolean(process.env.DRY_RUN, true);
const deleteInvalidRepos = parseBoolean(process.env.DELETE_INVALID_REPOS, true);
const pagesPath = process.env.PAGES_SOURCE_PATH || "/";
const siteOrigin = (process.env.SITE_ORIGIN || "https://webrpg.org").replace(/\/+$/, "");
const resultDir = process.env.RESULT_DIR || "workflow-results";
const scriptTag = process.env.ANALYTICS_SCRIPT_TAG
  || '<script defer src="https://insight.ravelloh.com/script.js?siteId=5ace6623-f51b-4571-8f60-e0473ea3317b"></script>';
const scriptNeedle = getScriptNeedle(scriptTag);
const htmlMaxBytes = parsePositiveInt(process.env.HTML_MAX_BYTES || "1048576");

if (!token) {
  throw new Error("WEBRPG_APP_TOKEN or GITHUB_TOKEN is required.");
}

if (!repoName) {
  throw new Error("REPO_NAME is required.");
}

const checkedAt = new Date().toISOString();
const result = {
  checkedAt,
  dryRun,
  targetOrg,
  repoName,
  forkName: repoName,
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
  console.log(`[error] ${targetOrg}/${repoName}: ${error.message}`);
  summary.push(`Status: \`check_error\``);
  summary.push(`Error: ${error.message}`);
}

await writeResult(result);
await writeStepSummary(summary);

async function run() {
  const repo = await githubRequest(`/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}`);
  result.repoUrl = repo.html_url;
  result.defaultBranch = repo.default_branch;
  result.sourceRepo = repo.source?.full_name || repo.parent?.full_name || null;

  if (!repo.fork) {
    result.status = "not_fork";
    result.invalidReason = "Repository is not a fork.";
    console.log(`[skip] ${targetOrg}/${repoName} is not a fork repository`);
    return;
  }

  const branch = repo.default_branch;
  const ref = await githubRequest(`/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}/git/ref/heads/${encodeGitRefPath(branch)}`);
  const headSha = ref.object.sha;
  const headCommit = await githubRequest(`/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}/git/commits/${headSha}`);
  const tree = await githubRequest(
    `/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}/git/trees/${headCommit.tree.sha}?recursive=1`,
  );

  const files = tree.tree.filter((item) => item.type === "blob");
  const htmlFiles = files
    .filter((item) => item.path.toLowerCase().endsWith(".html"))
    .filter((item) => !shouldSkipPath(item.path))
    .filter((item) => item.size <= htmlMaxBytes)
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  const htmlByPath = await loadHtmlContents(htmlFiles);
  const detection = detectRpgMakerProject(files, htmlByPath);

  result.htmlFileCount = htmlFiles.length;
  result.validationScore = detection.score;
  result.validationSignals = detection.signals;

  if (!detection.valid) {
    result.status = "invalid_structure";
    result.invalidReason = detection.reason;
    summary.push(`Status: \`invalid_structure\``);
    summary.push(`Reason: ${detection.reason}`);
    console.log(`[invalid] ${targetOrg}/${repoName}: ${detection.reason}`);

    if (!dryRun && deleteInvalidRepos) {
      await githubRequest(`/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}`, {
        method: "DELETE",
        ok: [204],
      });
      result.deleted = true;
      result.deletedAt = new Date().toISOString();
      console.log(`[deleted] ${targetOrg}/${repoName}`);
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

  // Compute game size metrics (zero additional API cost)
  result.totalSize = repo.size || 0;
  const dataSize = files
    .filter((f) => f.path.startsWith("data/") && f.path.endsWith(".json"))
    .reduce((sum, f) => sum + (f.size || 0), 0);
  result.dataSize = dataSize;

  const updates = new Map();

  // Check if a cover image already exists in the repo root
  const existingCoverFile = tree.tree.find(
    (item) => item.type === "blob" && /^cover\.(png|jpg|jpeg|webp)$/i.test(item.path),
  );
  if (existingCoverFile) {
    result.cover = `${getPagesUrl()}${existingCoverFile.path}`;
    result.coverPath = existingCoverFile.path;
    console.log(`[cover] Already exists: ${existingCoverFile.path}, skipping cover search`);
  } else {
    const coverResult = findCover(files, detection.projectRoot);
    if (coverResult) {
      result.cover = coverResult.pagesUrl;
      result.coverPath = coverResult.coverPath;

      if (coverResult.needsDecrypt) {
        try {
          const pngBuffer = await decryptRpgmvp(targetOrg, repoName, coverResult.coverFile.sha);
          result.coverPngBuffer = pngBuffer;
          console.log(`[cover] Will commit cover.png (${pngBuffer.length} bytes) from ${coverResult.coverPath}`);
        } catch (error) {
          console.log(`[cover] Failed to decrypt ${coverResult.coverPath}: ${error.message}`);
        }
      } else {
        // Unencrypted image — commit the original blob as cover.png
        try {
          const blob = await githubRequest(
            `/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}/git/blobs/${coverResult.coverFile.sha}`,
          );
          const imgBuffer = Buffer.from(blob.content, blob.encoding);
          result.coverPngBuffer = imgBuffer;
          console.log(`[cover] Will copy ${coverResult.coverPath} as cover.png (${imgBuffer.length} bytes)`);
        } catch (error) {
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

  if (detection.entryPath.toLowerCase() !== "index.html") {
    const redirect = buildRootRedirect(detection.entryPath);
    const existingRoot = htmlByPath.get("index.html");
    if (existingRoot !== redirect) {
      updates.set("index.html", redirect);
      result.redirectCreated = true;
    }
  }

  if (dryRun) {
    console.log(`[dry-run] Valid ${detection.engine} project at ${detection.entryPath}`);
    console.log(`[dry-run] Would update ${updates.size} HTML files.`);
    console.log(`[dry-run] Would enable GitHub Pages from ${branch}${pagesPath}.`);
    result.htmlFilesUpdated = updates.size;
    result.pagesEnabled = false;
    summary.push(`Status: \`verified\``);
    summary.push(`Engine: \`${detection.engine}\``);
    summary.push(`Entry: \`${detection.entryPath}\``);
    summary.push(`Cover: \`${result.cover || "none"}\``);
    summary.push(`HTML files to update: \`${updates.size}\``);
    summary.push(`Pages URL: \`${getPagesUrl()}\``);
    return;
  }

  // If a cover was found and needs to be committed as cover.png
  if (result.coverPngBuffer && !dryRun) {
    // Check if cover.png already exists with the same content
    const existingCover = tree.tree.find(
      (item) => item.path === "cover.png" && item.type === "blob",
    );
    const newSha = crypto.createHash("sha1").update(`blob ${result.coverPngBuffer.length}\0`).update(result.coverPngBuffer).digest("hex");
    if (existingCover && existingCover.sha === newSha) {
      console.log(`[cover] cover.png unchanged, skipping`);
    } else {
      updates.set("cover.png", result.coverPngBuffer);
      result.cover = `${getPagesUrl()}cover.png`;
      console.log(`[cover] ${existingCover ? "Updated" : "Added"} cover.png`);
    }
  }

  if (updates.size > 0) {
    await commitHtmlUpdates({
      branch,
      baseCommitSha: headSha,
      baseTreeSha: headCommit.tree.sha,
      updates,
    });
    const fileTypes = [...updates.keys()].map((k) => k.endsWith(".png") ? "cover.png" : k).join(", ");
    console.log(`[updated] ${updates.size} file(s) in ${targetOrg}/${repoName}: ${fileTypes}`);
  } else {
    console.log(`[skip] HTML already prepared in ${targetOrg}/${repoName}`);
  }

  await ensurePages(branch, pagesPath);
  result.htmlFilesUpdated = updates.size;
  result.pagesEnabled = true;
  summary.push(`Status: \`verified\``);
  summary.push(`Engine: \`${detection.engine}\``);
  summary.push(`Entry: \`${detection.entryPath}\``);
  summary.push(`Cover: \`${result.cover || "none"}\``);
  summary.push(`HTML files updated: \`${updates.size}\``);
  summary.push(`Pages URL: \`${getPagesUrl()}\``);
}

async function loadHtmlContents(htmlFiles) {
  const htmlByPath = new Map();

  for (const file of htmlFiles) {
    const blob = await githubRequest(`/repos/${encodeURIComponent(targetOrg)}/${encodeURIComponent(repoName)}/git/blobs/${file.sha}`);
    htmlByPath.set(file.path, Buffer.from(blob.content, blob.encoding).toString("utf8"));
  }

  return htmlByPath;
}

function detectRpgMakerProject(files, htmlByPath) {
  const fileByLowerPath = new Map(files.map((file) => [file.path.toLowerCase(), file]));
  const candidates = [];

  for (const [htmlPath, content] of htmlByPath) {
    for (const scriptSrc of getScriptSources(content)) {
      const normalizedScript = normalizeRepoPath(path.posix.join(path.posix.dirname(htmlPath), scriptSrc));
      const lowerScript = normalizedScript.toLowerCase();

      if (lowerScript.endsWith("js/rpg_core.js") || lowerScript.endsWith("js/rmmz_core.js")) {
        const engine = lowerScript.endsWith("js/rmmz_core.js") ? "RPG Maker MZ" : "RPG Maker MV";
        const projectRoot = lowerScript.slice(0, lowerScript.length - (engine === "RPG Maker MZ" ? "js/rmmz_core.js".length : "js/rpg_core.js".length));
        candidates.push(scoreCandidate({
          engine,
          projectRoot,
          entryPath: htmlPath,
          fileByLowerPath,
          htmlByPath,
          source: "html-script",
        }));
      }
    }
  }

  for (const file of files) {
    const lower = file.path.toLowerCase();
    if (lower.endsWith("js/rpg_core.js") || lower.endsWith("js/rmmz_core.js")) {
      const engine = lower.endsWith("js/rmmz_core.js") ? "RPG Maker MZ" : "RPG Maker MV";
      const corePath = engine === "RPG Maker MZ" ? "js/rmmz_core.js" : "js/rpg_core.js";
      const projectRoot = lower.slice(0, lower.length - corePath.length);
      const entryPath = findEntryPath(projectRoot, htmlByPath);

      if (entryPath) {
        candidates.push(scoreCandidate({
          engine,
          projectRoot,
          entryPath,
          fileByLowerPath,
          htmlByPath,
          source: "tree-core",
        }));
      }
    }
  }

  candidates.sort((left, right) => right.score - left.score || left.entryPath.localeCompare(right.entryPath, "en"));
  const best = candidates[0];

  if (!best) {
    return {
      valid: false,
      score: 0,
      signals: [],
      reason: "No RPG Maker MV/MZ HTML entry point or core scripts were found.",
    };
  }

  if (best.score < 65) {
    return {
      ...best,
      valid: false,
      reason: `RPG Maker structure is incomplete near ${best.entryPath}.`,
    };
  }

  return {
    ...best,
    valid: true,
    reason: "",
  };
}

function scoreCandidate({ engine, projectRoot, entryPath, fileByLowerPath, htmlByPath, source }) {
  const lowerRoot = projectRoot.toLowerCase();
  const coreFile = engine === "RPG Maker MZ" ? "js/rmmz_core.js" : "js/rpg_core.js";
  const required = engine === "RPG Maker MZ"
    ? ["js/rmmz_core.js", "js/rmmz_managers.js", "js/rmmz_objects.js", "js/rmmz_scenes.js", "js/rmmz_sprites.js", "js/rmmz_windows.js", "js/plugins.js", "js/main.js"]
    : ["js/rpg_core.js", "js/rpg_managers.js", "js/rpg_objects.js", "js/rpg_scenes.js", "js/rpg_sprites.js", "js/rpg_windows.js", "js/plugins.js", "js/main.js"];
  const signals = [source];
  let score = 0;

  if (htmlByPath.has(entryPath)) {
    score += 20;
    signals.push("html-entry");
  }

  const entryContent = htmlByPath.get(entryPath) || "";
  if (entryContent.toLowerCase().includes(coreFile)) {
    score += 25;
    signals.push("html-core-reference");
  }

  for (const file of required) {
    if (fileByLowerPath.has(`${lowerRoot}${file}`)) {
      score += file === coreFile ? 20 : 5;
      signals.push(file);
    }
  }

  if (fileByLowerPath.has(`${lowerRoot}data/system.json`)) {
    score += 10;
    signals.push("data/System.json");
  }

  if (entryPath.toLowerCase() === "index.html") {
    score += 8;
    signals.push("root-index");
  } else if (entryPath.toLowerCase().endsWith("/index.html")) {
    score += 5;
    signals.push("subdir-index");
  }

  const htmlPathsToPatch = [...htmlByPath.keys()]
    .filter((htmlPath) => {
      if (htmlPath === entryPath) {
        return true;
      }

      const content = htmlByPath.get(htmlPath).toLowerCase();
      return content.includes(coreFile) || content.includes("js/plugins.js");
    })
    .sort((left, right) => left.localeCompare(right, "en"));

  return {
    engine,
    projectRoot,
    entryPath,
    htmlPathsToPatch,
    score,
    signals,
  };
}

function findEntryPath(projectRoot, htmlByPath) {
  const candidates = [
    `${projectRoot}index.html`,
    `${projectRoot}www/index.html`,
  ].map(normalizeRepoPath);
  const lowerHtmlPaths = new Map([...htmlByPath.keys()].map((htmlPath) => [htmlPath.toLowerCase(), htmlPath]));

  for (const candidate of candidates) {
    const match = lowerHtmlPaths.get(candidate.toLowerCase());
    if (match) {
      return match;
    }
  }

  for (const [htmlPath, content] of htmlByPath) {
    const lowerContent = content.toLowerCase();
    if (lowerContent.includes("rpg_core.js") || lowerContent.includes("rmmz_core.js")) {
      return htmlPath;
    }
  }

  return null;
}

function getScriptSources(content) {
  const sources = [];
  const scriptPattern = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  let match;

  while ((match = scriptPattern.exec(content)) !== null) {
    const src = match[1].trim();
    if (!src || /^[a-z][a-z0-9+.-]*:\/\//i.test(src) || src.startsWith("//")) {
      continue;
    }

    sources.push(src.split(/[?#]/, 1)[0]);
  }

  return sources;
}

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

function buildRootRedirect(entryPath) {
  const escapedPath = escapeHtml(encodeURI(entryPath));
  const escapedTitle = escapeHtml(`${targetOrg}/${repoName}`);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="refresh" content="0; url=${escapedPath}">
    <title>${escapedTitle}</title>
    ${scriptTag}
    <script>location.replace(${JSON.stringify(entryPath)});</script>
  </head>
  <body style="background:#000;color:#fff;font-family:sans-serif">
    <a href="${escapedPath}">Start game</a>
  </body>
</html>
`;
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
    return created;
  }

  const source = current.source || {};
  if (source.branch === branch && source.path === sourcePath) {
    console.log(`[pages] already enabled ${getPagesUrl()}`);
    return current;
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
  return current;
}

async function githubRequest(apiPath, options = {}) {
  const maxRetries = 5;
  const baseDelayMs = 10_000;
  const maxDelayMs = 300_000; // 5 min max wait

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response = await fetch(`${apiBase}${apiPath}`, {
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

    if (ok.includes(response.status)) {
      if (response.status === 404) {
        return { status: 404 };
      }
      return data;
    }

    // Rate limit: retry with exponential backoff, capped at maxDelayMs
    if (response.status === 403 || response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const delayMs = retryAfter
        ? Number.parseInt(retryAfter, 10) * 1000
        : Math.min(baseDelayMs * (2 ** attempt), maxDelayMs);

      if (attempt < maxRetries) {
        const waitSec = Math.round(delayMs / 1000);
        console.log(`[rate-limit] ${(data?.message || "").slice(0, 60)}; waiting ${waitSec}s before retry ${attempt + 1}/${maxRetries}`);
        await sleep(delayMs);
        continue;
      }
    }

    const message = data?.message || response.statusText;
    throw new Error(`GitHub API ${response.status}: ${message}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function shouldSkipPath(repoPath) {
  return /(^|\/)(node_modules|vendor|coverage|\.git|\.github)\//i.test(repoPath);
}

function normalizeRepoPath(repoPath) {
  return repoPath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function writeResult(data) {
  await fs.mkdir(resultDir, { recursive: true });
  const resultPath = path.join(resultDir, `${repoName}.json`);
  await fs.writeFile(resultPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function writeStepSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) {
    return;
  }

  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}
