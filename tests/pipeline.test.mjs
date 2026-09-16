import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { getForkNames } from "../scripts/repo-identity.mjs";
import { normalizeList } from "../scripts/normalize-list.mjs";
import { DATABASE_FILES, detectRpgMakerProject, flattenEntries, runtimeFiles } from "../scripts/rpgmaker-project.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const preload = fileURLToPath(new URL("helpers/mock-fetch.mjs", import.meta.url));
const analytics = '<script defer src="https://insight.ravelloh.com/script.js?siteId=5ace6623-f51b-4571-8f60-e0473ea3317b"></script>';
const entry = { id: "alice-game", title: "Game", owner: "Alice", name: "game", repo: "https://github.com/Alice/game", status: "indexed", forkName: "Alice-game" };

function gameFiles({ engine = "RPG Maker MV", prefix = "", entryName = "index.html", prepared = false } = {}) {
  const runtime = runtimeFiles(engine);
  const html = `<html>\n<head>\n<title>Game</title>\n${(engine === "RPG Maker MZ" ? ["js/main.js"] : runtime).map((name) => `<script src="${name}"></script>`).join("\n")}\n${prepared ? analytics : ""}\n</head>\n</html>`;
  const files = Object.fromEntries(runtime.concat(DATABASE_FILES).map((name) => [prefix + name, name.endsWith(".json") ? "{}" : "// runtime"]));
  files[prefix + "js/main.js"] = engine === "RPG Maker MZ" ? `const scriptUrls = ${JSON.stringify(runtime.filter((name) => name !== "js/main.js"))};` : "SceneManager.run(Scene_Boot);";
  files[prefix + entryName] = html;
  return files;
}

async function workspace(t, list = [entry], fixture = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "webrpg-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "list.json"), JSON.stringify(list));
  const write = async (name, data) => {
    const destination = path.join(dir, name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, JSON.stringify(data));
  };
  const read = async (name) => JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
  const run = async (script, env = {}, nextFixture = fixture) => {
    await write("fixture.json", nextFixture);
    const output = await exec(process.execPath, ["--import", preload, path.join(root, "scripts", script)], { cwd: dir, env: { ...process.env, WEBRPG_APP_TOKEN: "mock", WEBRPG_SEARCH_TOKEN: "mock", WEBRPG_FORK_TOKEN: "mock", DRY_RUN: "false", REPO_NAME: "Alice-game", TEST_FIXTURE: path.join(dir, "fixture.json"), TEST_SNAPSHOT: path.join(dir, "snapshot.json"), SEARCH_DELAY_SECONDS: "0", CREATE_DELAY_SECONDS: "0", ...env } });
    return { ...output, snapshot: await read("snapshot.json") };
  };
  return { dir, read, write, run };
}

test("names reserve terminal and recorded entries regardless of order", () => {
  const entries = [{ ...entry, owner: "a-b", name: "c", status: "invalid_structure", forkName: "a-b-c" }, { ...entry, id: "second", owner: "a", name: "b-c", forkName: undefined }];
  const names = getForkNames(entries);
  assert.equal(names.get("a-b/c"), "a-b-c");
  assert.notEqual(names.get("a/b-c"), "a-b-c");
  assert.deepEqual(getForkNames([...entries].reverse()), names);
});

test("recorded names win over an earlier computed name", () => {
  const names = getForkNames([{ ...entry, owner: "a", name: "b-c", forkName: undefined }, { ...entry, owner: "a-b", name: "c", forkName: "a-b-c" }]);
  assert.notEqual(names.get("a/b-c"), "a-b-c");
});

test("new sources cannot steal names from older queued sources", () => {
  const older = { ...entry, owner: "a-b", name: "c", forkName: undefined, plannedForkName: "a-b-c" };
  const newcomer = { ...entry, owner: "a", name: "b-c", forkName: undefined };
  const names = getForkNames([newcomer, older]);
  assert.equal(names.get("a-b/c"), "a-b-c");
  assert.notEqual(names.get("a/b-c"), "a-b-c");
});

test("metadata normalization queues verified entries without a public link", () => {
  const [queued, valid, retired] = normalizeList([{ ...entry, status: "verified", pagesUrl: undefined, checkedAt: "old", sourceHeadSha: "old", cover: "old" }, { ...entry, owner: "Bob", status: "verified", pagesUrl: "https://webrpg.org/Bob-game/", invalidReason: "old", deletedAt: "old" }, { ...entry, owner: "Carol", status: "unavailable", pagesUrl: "old", cover: "old" }]);
  assert.equal(queued.status, "indexed");
  assert.equal(queued.checkedAt, undefined);
  assert.equal(queued.sourceHeadSha, undefined);
  assert.equal(valid.invalidReason, undefined);
  assert.equal(valid.deletedAt, undefined);
  assert.equal(retired.pagesUrl, undefined);
});

test("historical root links for non-index entries are corrected", () => {
  const [updated] = normalizeList([{ ...entry, status: "verified", entryPath: "game.html", pagesUrl: "https://webrpg.org/Alice-game/" }]);
  assert.equal(updated.pagesUrl, "https://webrpg.org/Alice-game/game.html");
});

test("structure requires actual startup libraries and database files", () => {
  const contents = gameFiles();
  delete contents["js/main.js"];
  delete contents["data/System.json"];
  const files = Object.keys(contents).map((name) => ({ path: name }));
  const detected = detectRpgMakerProject(files, new Map([["index.html", contents["index.html"]]]), new Map());
  assert.equal(detected.valid, false);
  assert.match(detected.reason, /Missing files/);
});

test("structure rejects references with the wrong case", () => {
  const contents = gameFiles();
  contents["js/Rpg_core.js"] = contents["js/rpg_core.js"];
  delete contents["js/rpg_core.js"];
  const detected = detectRpgMakerProject(Object.keys(contents).map((name) => ({ path: name })), new Map([["index.html", contents["index.html"]]]), new Map([["js/main.js", contents["js/main.js"]]]));
  assert.equal(detected.valid, false);
});

test("flattening requires real project files and preserves outside modes", () => {
  assert.throws(() => flattenEntries([{ path: "README.md", type: "blob", mode: "100644", sha: "r" }], "Game/"), /no files/);
  const result = flattenEntries([{ path: "Game/index.html", type: "blob", mode: "100644", sha: "game" }, { path: "index.html", type: "blob", mode: "100644", sha: "landing" }, { path: "run.sh", type: "blob", mode: "100755", sha: "run" }], "Game/");
  assert.equal(result.find((item) => item.path === "index.html").sha, "game");
  assert.equal(result.find((item) => item.path === "run.sh").mode, "100755");
});

test("flattening refuses file/directory collisions", () => {
  assert.throws(() => flattenEntries([{ path: "Game/img/a.png", type: "blob", sha: "a" }, { path: "img", type: "blob", sha: "b" }], "Game/"), /conflicts/);
});

for (const engine of ["RPG Maker MV", "RPG Maker MZ"]) {
  test(`live ${engine} deployment passes without constant initialization errors`, async (t) => {
    const w = await workspace(t, [entry], { files: gameFiles({ engine, prepared: true }) });
    await w.run("process-fork-repo.mjs");
    const result = await w.read("workflow-results/Alice-game.json");
    assert.equal(result.status, "verified", result.error);
    assert.equal(result.reachable, true);
    assert.equal(result.entryId, entry.id);
  });
}

test("flattening a nested game cannot inject the old landing page", async (t) => {
  const files = { "index.html": "<title>Landing</title>", "README.md": "license and readme", ...gameFiles({ prefix: "Game/" }) };
  const w = await workspace(t, [entry], { files });
  const { snapshot } = await w.run("process-fork-repo.mjs");
  const result = await w.read("workflow-results/Alice-game.json");
  assert.equal(result.status, "verified", result.error);
  assert.match(snapshot.files["index.html"], /<title>Game<\/title>/);
  assert.ok(snapshot.files["index.html"].includes(analytics));
  assert.equal(snapshot.files["README.md"], files["README.md"]);
  assert.equal(result.verificationDeferred, true);
});

test("nested game receives analytics even without an old root page", async (t) => {
  const w = await workspace(t, [entry], { files: gameFiles({ prefix: "www/" }) });
  const { snapshot } = await w.run("process-fork-repo.mjs");
  assert.ok(snapshot.files["index.html"].includes(analytics));
});

test("non-index public links point to the entry being checked", async (t) => {
  const w = await workspace(t, [entry], { files: gameFiles({ entryName: "game.html", prepared: true }) });
  const { snapshot } = await w.run("process-fork-repo.mjs");
  const result = await w.read("workflow-results/Alice-game.json");
  assert.equal(result.status, "verified", result.error);
  assert.equal(result.pagesUrl, "https://webrpg.org/Alice-game/game.html");
  assert.equal(snapshot.requests.find((item) => item.url.startsWith("https://webrpg.org")).url, result.pagesUrl);
});

test("a missing deployed startup resource fails the check", async (t) => {
  const files = gameFiles({ prepared: true });
  const deployedFiles = { ...files };
  delete deployedFiles["js/rpg_objects.js"];
  const w = await workspace(t, [entry], { files, deployedFiles });
  await w.run("process-fork-repo.mjs");
  const result = await w.read("workflow-results/Alice-game.json");
  assert.equal(result.status, "check_error");
  assert.match(result.error, /rpg_objects.js.*404/);
});

test("HTTP 200 bot challenges remain inconclusive", async (t) => {
  const w = await workspace(t, [entry], { files: gameFiles({ prepared: true }), siteResponse: { status: 200, body: "Just a moment", headers: { "cf-mitigated": "challenge" } } });
  await w.run("process-fork-repo.mjs");
  const result = await w.read("workflow-results/Alice-game.json");
  assert.equal(result.status, "verified");
  assert.equal(result.reachable, false);
  assert.match(result.reachabilityDetail, /bot challenge/);
});

test("detached hidden repositories are kept", async (t) => {
  const w = await workspace(t, [{ ...entry, status: "hidden" }], { files: gameFiles() });
  const { snapshot } = await w.run("process-fork-repo.mjs");
  assert.equal((await w.read("workflow-results/Alice-game.json")).status, "hidden");
  assert.equal(snapshot.requests.filter((item) => item.method === "DELETE").length, 0);
});

test("index duplicate recovery initializes its constants before use", async (t) => {
  const w = await workspace(t, [{ ...entry, status: "duplicate_name", duplicateReason: "Repository name already exists in list.json." }]);
  await w.run("index-github-rpgmaker-repos.mjs");
  assert.equal((await w.read("list.json"))[0].status, "indexed");
});

function searchItem(owner, name, sha, filePath = "index.html") {
  return { sha, path: filePath, repository: { full_name: `${owner}/${name}`, name, html_url: `https://github.com/${owner}/${name}`, owner: { login: owner } } };
}

test("same-name candidates survive the per-run budget and are indexed later", async (t) => {
  const html = gameFiles()["index.html"];
  const fixture = { blobs: { bob: html, carol: html }, searchResults: { "rpg_core.js extension:html": [searchItem("Bob", "game", "bob"), searchItem("Carol", "game", "carol")] } };
  const w = await workspace(t, [entry], fixture);
  await w.run("index-github-rpgmaker-repos.mjs", { MAX_CANDIDATES_PER_RUN: "1" });
  assert.equal((await w.read("list.json")).length, 2);
  assert.equal((await w.read("candidate-queue.json"))[0].owner, "Carol");
  await w.run("index-github-rpgmaker-repos.mjs", { MAX_CANDIDATES_PER_RUN: "1" });
  assert.equal((await w.read("list.json")).length, 3);
  assert.deepEqual(await w.read("candidate-queue.json"), []);
});

test("MZ main.js discovery finds its dynamically loaded HTML entry", async (t) => {
  const files = gameFiles({ engine: "RPG Maker MZ" });
  const w = await workspace(t, [], { files, blobs: { mz: files["js/main.js"] }, searchResults: { "rmmz_core.js filename:main.js": [searchItem("Bob", "MZ", "mz", "js/main.js")] } });
  await w.run("index-github-rpgmaker-repos.mjs");
  const list = await w.read("list.json");
  assert.equal(list.length, 1);
  assert.equal(list[0].engine, "RPG Maker MZ");
  assert.equal(list[0].sourcePath, "index.html");
});

test("fork reports record actual names and are emitted even without failures", async (t) => {
  const w = await workspace(t, [entry], { orgRepos: [{ name: "legacy-game", fork: true, parent: { full_name: "Alice/game" } }] });
  await w.run("fork-listed-repos.mjs");
  const report = await w.read("fork-failures/fork-failures.json");
  assert.equal(report.forks[0].forkName, "legacy-game");
  assert.equal(report.forks[0].entryId, entry.id);
  assert.deepEqual(report.failures, []);
  await w.write("workflow-failures/report.json", report);
  await w.run("plan-fork-repos.mjs");
  const plan = await w.read("workflow-plan/plan.json");
  assert.equal(plan.targets[0].repo, "legacy-game");
  assert.equal(plan.targets[0].entryId, entry.id);
});

test("missing results advance failures and the queue even with no artifacts", async (t) => {
  const w = await workspace(t);
  await w.write("workflow-plan/plan.json", { checkedAt: "2026-09-16T01:00:00Z", targets: [{ repo: "Alice-game", entryId: entry.id, indexedSource: "alice/game" }] });
  await w.run("update-list-from-results.mjs");
  const updated = (await w.read("list.json"))[0];
  assert.equal(updated.status, "check_error");
  assert.equal(updated.checkedAt, "2026-09-16T01:00:00Z");
  assert.equal(updated.consecutiveFailures, 1);
  assert.match(updated.lastCheckError, /produced no result/);
  await w.run("update-list-from-results.mjs", { RETRY_LIMIT: "2" });
  assert.equal((await w.read("list.json"))[0].status, "retry_exhausted");
});

test("collision results cannot revive a terminal entry or reach another source", async (t) => {
  const retired = { ...entry, id: "retired", owner: "a-b", name: "c", status: "invalid_structure", forkName: "a-b-c" };
  const active = { ...entry, id: "active", owner: "a", name: "b-c", forkName: undefined };
  const names = getForkNames([retired, active]);
  const forkName = names.get("a/b-c");
  const w = await workspace(t, [retired, active], { orgRepos: [{ name: forkName, fork: false }] });
  await w.run("plan-fork-repos.mjs");
  assert.equal((await w.read("workflow-plan/plan.json")).targets[0].repo, forkName);
  await w.write("workflow-results/result.json", { entryId: "active", indexedSource: "a/b-c", forkName, status: "verified", pagesUrl: `https://webrpg.org/${forkName}/`, entryPath: "index.html", sourceRepo: "root/another-game" });
  await w.run("update-list-from-results.mjs");
  const list = await w.read("list.json");
  assert.equal(list.find((item) => item.id === "retired").status, "invalid_structure");
  assert.equal(list.find((item) => item.id === "active").status, "verified");
  assert.equal(list.find((item) => item.id === "active").owner, "a");
});

test("aggregation processes fork failures even with an empty prepare plan", async (t) => {
  const w = await workspace(t, [{ ...entry, forkName: undefined }]);
  await w.write("workflow-plan/plan.json", { targets: [] });
  await w.write("workflow-failures/report.json", { checkedAt: "2026-09-16T01:00:00Z", failures: [{ source: "Alice/game", kind: "permanent", message: "Not Found" }] });
  await w.run("update-list-from-results.mjs");
  const updated = (await w.read("list.json"))[0];
  assert.equal(updated.status, "unavailable");
  assert.equal(updated.checkedAt, "2026-09-16T01:00:00Z");
});

test("transient failures preserve verified links until the threshold", async (t) => {
  const list = [{ ...entry, status: "verified", pagesUrl: "https://webrpg.org/Alice-game/", cover: "https://webrpg.org/Alice-game/cover.png" }];
  const w = await workspace(t, list);
  await w.write("workflow-results/result.json", { entryId: entry.id, indexedSource: "alice/game", forkName: "Alice-game", status: "check_error", failureKind: "transient", error: "Rate limit" });
  await w.run("update-list-from-results.mjs");
  let updated = (await w.read("list.json"))[0];
  assert.equal(updated.status, "verified");
  assert.ok(updated.pagesUrl);
  assert.ok(updated.cover);
  await w.run("update-list-from-results.mjs");
  await w.run("update-list-from-results.mjs");
  updated = (await w.read("list.json"))[0];
  assert.equal(updated.status, "check_error");
  assert.equal(updated.pagesUrl, undefined);
  assert.equal(updated.cover, undefined);
});

test("successful checks clear errors and stale retirement metadata", async (t) => {
  const w = await workspace(t, [{ ...entry, status: "check_error", invalidReason: "old", deletedAt: "old", duplicateReason: "old", consecutiveFailures: 4 }]);
  await w.write("workflow-results/result.json", { entryId: entry.id, indexedSource: "alice/game", forkName: "Alice-game", status: "verified", pagesUrl: "https://webrpg.org/Alice-game/", entryPath: "index.html", coverPath: "cover.png" });
  await w.run("update-list-from-results.mjs");
  const updated = (await w.read("list.json"))[0];
  for (const field of ["invalidReason", "deletedAt", "duplicateReason", "lastCheckError", "consecutiveFailures"]) assert.equal(updated[field], undefined);
  assert.equal(updated.coverPath, "cover.png");
});

test("a failed candidate is moved behind the remaining queue", async (t) => {
  const html = gameFiles()["index.html"];
  const fixture = { blobs: { bob: html, carol: html }, searchResults: { "rpg_core.js extension:html": [searchItem("Bob", "game", "bob"), searchItem("Carol", "game", "carol")] } };
  const w = await workspace(t, [entry], fixture);
  await w.run("index-github-rpgmaker-repos.mjs", { MAX_CANDIDATES_PER_RUN: "1" }, { ...fixture, failRequest: "/git/blobs/bob", failRequestStatus: 500 });
  assert.equal((await w.read("candidate-queue.json"))[0].owner, "Carol");
  assert.equal((await w.read("candidate-queue.json"))[1].owner, "Bob");
  await w.run("index-github-rpgmaker-repos.mjs", { MAX_CANDIDATES_PER_RUN: "1" });
  assert.ok((await w.read("list.json")).some((item) => item.owner === "Carol"));
});

test("duplicate recovery cannot hide the verified owner when sorted first", () => {
  const verified = { ...entry, status: "verified", pagesUrl: "https://webrpg.org/Alice-game/" };
  const duplicate = { ...entry, id: "duplicate", status: "duplicate_name", duplicateReason: "This repository is already listed." };
  const normalized = normalizeList([duplicate, verified]);
  assert.equal(normalized.find((item) => item.id === entry.id).status, "verified");
  assert.equal(normalized.find((item) => item.id === "duplicate").status, "duplicate_name");
});

test("a wrong-source artifact cannot verify a planned entry", async (t) => {
  const w = await workspace(t);
  await w.write("workflow-plan/plan.json", { targets: [{ entryId: entry.id, indexedSource: "alice/game", repo: "Alice-game" }] });
  await w.write("workflow-results/result.json", { entryId: entry.id, indexedSource: "bob/game", forkName: "Alice-game", status: "verified", pagesUrl: "wrong" });
  await w.run("update-list-from-results.mjs");
  const updated = (await w.read("list.json"))[0];
  assert.equal(updated.status, "check_error");
  assert.equal(updated.pagesUrl, undefined);
});

test("unrelated target repositories are reported instead of claimed", async (t) => {
  const w = await workspace(t, [{ ...entry, forkName: undefined }], { orgRepos: [{ name: "Alice-game", fork: false }] });
  await w.run("fork-listed-repos.mjs");
  const report = await w.read("fork-failures/fork-failures.json");
  assert.deepEqual(report.forks, []);
  assert.equal(report.failures[0].kind, "permanent");
  await w.write("workflow-failures/report.json", report);
  await w.run("plan-fork-repos.mjs");
  assert.deepEqual((await w.read("workflow-plan/plan.json")).targets, []);
});
