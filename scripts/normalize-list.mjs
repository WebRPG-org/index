import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { getForkNames, sourceKey } from "./repo-identity.mjs";
import { isTerminalStatus } from "./repo-status.mjs";

export const DERIVED_FIELDS = ["pagesUrl", "cover", "coverPath", "entryPath", "projectRoot", "reachable", "reachabilityDetail", "verificationDeferred"];

const OWN_DUPLICATE_REASONS = new Set([
  "Repository name already exists in list.json.",
  "This repository is already listed.",
]);

export function markDuplicateRepositories(entries) {
  const primaryIds = new Map();
  for (const entry of entries) {
    const key = sourceKey(entry);
    if (!primaryIds.has(key) || (primaryIds.get(key).status === "duplicate_name" && entry.status !== "duplicate_name")) primaryIds.set(key, entry);
  }
  return entries.map((entry) => {
    if (primaryIds.get(sourceKey(entry)).id !== entry.id) {
      if (isTerminalStatus(entry) && entry.status !== "duplicate_name") return entry;
      return { ...entry, status: "duplicate_name", duplicateReason: "This repository is already listed." };
    }
    if (entry.status !== "duplicate_name" || !OWN_DUPLICATE_REASONS.has(entry.duplicateReason)) return entry;
    const revived = { ...entry, status: "indexed" };
    for (const field of DERIVED_FIELDS.concat("duplicateReason", "invalidReason", "checkedAt", "sourceHeadSha", "processedHeadSha", "lastCheckError", "consecutiveFailures", "lastFailedAt")) delete revived[field];
    return revived;
  });
}

export function normalizeEntry(entry) {
  const updated = { ...entry };
  if (updated.status === "verified" && !updated.pagesUrl) {
    updated.status = "indexed";
    delete updated.checkedAt;
    delete updated.sourceHeadSha;
    delete updated.processedHeadSha;
  }
  const preserveLink = updated.status === "verified" && updated.pagesUrl;
  if (!preserveLink) for (const field of DERIVED_FIELDS) delete updated[field];
  if (preserveLink) {
    // Historical non-index entries were advertised at the repository root
    // even though the check targeted their actual entry file.
    if (updated.entryPath && !updated.entryPath.includes("/") && updated.entryPath !== "index.html" && updated.pagesUrl.endsWith("/")) {
      updated.pagesUrl = new URL(encodeURIComponent(updated.entryPath), updated.pagesUrl).href;
    }
    for (const field of ["invalidReason", "deletedAt", "duplicateReason"]) delete updated[field];
    if (!updated.consecutiveFailures) {
      for (const field of ["lastCheckError", "consecutiveFailures", "lastFailedAt"]) delete updated[field];
    }
  }
  if (isTerminalStatus(updated)) {
    for (const field of DERIVED_FIELDS) delete updated[field];
  }
  if (updated.status === "indexed") {
    for (const field of ["invalidReason", "lastCheckError", "consecutiveFailures", "lastFailedAt"]) delete updated[field];
  }
  return updated;
}

export function normalizeList(entries) {
  const normalized = markDuplicateRepositories(entries).map(normalizeEntry);
  const names = getForkNames(normalized);
  for (const entry of normalized) {
    if (entry.forkName) delete entry.plannedForkName;
    else entry.plannedForkName = names.get(sourceKey(entry));
  }
  return normalized;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const listPath = process.env.LIST_PATH || "list.json";
  const list = JSON.parse(await fs.readFile(listPath, "utf8"));
  await fs.writeFile(listPath, `${JSON.stringify(normalizeList(list), null, 2)}\n`, "utf8");
}
