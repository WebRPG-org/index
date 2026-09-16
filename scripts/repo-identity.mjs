import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export function sourceKey(entry) {
  if (!entry.owner || !entry.name) throw new Error("A list entry needs an owner and name.");
  return `${entry.owner}/${entry.name}`.toLowerCase();
}

export function shortHash(value) {
  return crypto.createHash("sha1").update(value.toLowerCase()).digest("hex").slice(0, 8);
}

export function makeForkName(owner, name) {
  const raw = `${owner}-${name}`;
  const safe = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^[.-]+|[.-]+$/g, "") || `repo-${shortHash(raw)}`;
  return safe.length <= 100 ? safe : `${safe.slice(0, 91).replace(/[.-]+$/g, "")}-${shortHash(raw)}`;
}

// Allocate against the entire index, including tombstones. Reserve recorded
// names before computed names, and persist planned names when indexing so a
// later candidate cannot change the name of an already queued repository.
export function getUniqueSources(entries, forkRecords = new Map()) {
  const groups = new Map();
  for (const entry of entries) {
    const key = sourceKey(entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const sources = [...groups].sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, group]) => {
    const entry = group.find((item) => item.status !== "duplicate_name") || group[0];
    const recorded = forkRecords.get(key)?.forkName || group.find((item) => item.forkName)?.forkName;
    const planned = group.find((item) => item.plannedForkName)?.plannedForkName;
    return { key, source: `${entry.owner}/${entry.name}`, owner: entry.owner, name: entry.name, repo: entry.repo, entryId: entry.id, entry, forkName: recorded || planned, recorded: Boolean(recorded) };
  });
  const used = new Set(entries.filter((item) => item.forkName).map((item) => item.forkName.toLowerCase()));
  for (const record of forkRecords.values()) used.add(record.forkName.toLowerCase());
  const assigned = new Set(sources.filter((item) => item.recorded).map((item) => item.key));
  // A new source sorting before an older queued source cannot steal the older
  // source's persistent planned name.
  for (const item of sources) {
    if (!item.recorded && item.forkName && !used.has(item.forkName.toLowerCase())) {
      used.add(item.forkName.toLowerCase());
      assigned.add(item.key);
    }
  }
  for (const item of sources) {
    if (assigned.has(item.key)) continue;
    let name = item.forkName || makeForkName(item.owner, item.name);
    let attempt = 0;
    while (used.has(name.toLowerCase())) {
      const suffix = shortHash(`${item.source}${attempt ? `/${attempt}` : ""}`);
      name = makeForkName(item.owner, `${item.name}-${suffix}`);
      attempt += 1;
    }
    item.forkName = name;
    used.add(name.toLowerCase());
  }
  return sources;
}

export function getForkNames(entries, forkRecords) {
  return new Map(getUniqueSources(entries, forkRecords).map((item) => [item.key, item.forkName]));
}

export async function listJsonFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listJsonFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(fullPath);
  }
  return files.sort();
}

export async function readForkRecords(dir) {
  const records = new Map();
  for (const file of await listJsonFiles(dir)) {
    const report = JSON.parse(await fs.readFile(file, "utf8"));
    for (const fork of report.forks || []) {
      records.set(fork.source.toLowerCase(), { ...fork, checkedAt: fork.checkedAt || report.checkedAt });
    }
  }
  return records;
}

export async function readForkFailures(dir) {
  const failures = new Map();
  for (const file of await listJsonFiles(dir)) {
    const report = JSON.parse(await fs.readFile(file, "utf8"));
    for (const failure of report.failures || []) {
      const key = String(failure.source || "").toLowerCase();
      if (!failures.has(key) || failure.kind === "permanent") failures.set(key, { ...failure, checkedAt: failure.checkedAt || report.checkedAt });
    }
  }
  return failures;
}
