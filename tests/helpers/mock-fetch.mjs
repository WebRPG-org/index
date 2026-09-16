import fs from "node:fs";
import crypto from "node:crypto";

const fixture = JSON.parse(fs.readFileSync(process.env.TEST_FIXTURE, "utf8"));
const requests = [];
const blobs = new Map(Object.entries(fixture.blobs || {}));
const trees = new Map();
const commits = new Map();
let sequence = 0;
let head = "head";
let pages = fixture.pages === false ? null : { source: { branch: "main", path: "/" } };
const orgRepos = fixture.orgRepos || [];

function blobSha(content) {
  return crypto.createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex");
}
function makeFiles(contents) {
  return Object.entries(contents || {}).map(([name, content]) => {
    const sha = blobSha(content);
    blobs.set(sha, content);
    return { path: name, mode: "100644", type: "blob", sha, size: Buffer.byteLength(content) };
  });
}
const initialFiles = makeFiles(fixture.files);
trees.set("tree", initialFiles);
commits.set(head, "tree");

function response(data, status = 200, headers = {}) {
  return new Response([204, 304].includes(status) ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}

globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(url);
  const method = options.method || "GET";
  const pathname = decodeURIComponent(parsed.pathname);
  const body = options.body ? JSON.parse(options.body) : undefined;
  requests.push({ url, pathname, method, body });
  if (fixture.failRequest && pathname.includes(fixture.failRequest)) return response({ message: "Simulated API failure" }, fixture.failRequestStatus || 404);
  if (parsed.hostname === "webrpg.org") {
    const override = fixture.siteResponses?.[pathname] || fixture.siteResponse;
    if (override?.networkError) throw new Error("simulated network error");
    const relative = pathname.replace(/^\/[^/]+\//, "") || "index.html";
    const deployed = fixture.deployedFiles || fixture.files;
    const content = override?.body ?? deployed?.[relative];
    const status = override?.status || (content === undefined ? 404 : 200);
    const type = relative.endsWith(".html") ? "text/html" : relative.endsWith(".json") ? "application/json" : "application/javascript";
    return new Response(method === "HEAD" ? null : (content ?? "Not found"), { status, headers: { "content-type": type, ...override?.headers } });
  }
  if (parsed.hostname !== "api.github.com") throw new Error(`Unexpected host: ${parsed.hostname}`);
  if (pathname === "/search/code") {
    const query = parsed.searchParams.get("q");
    const items = fixture.searchResults?.[query] || [];
    return response({ items });
  }
  if (pathname.startsWith("/orgs/") && pathname.endsWith("/repos")) {
    const start = (Number(parsed.searchParams.get("page")) - 1) * 100;
    return response(orgRepos.slice(start, start + 100));
  }
  if (pathname.endsWith("/forks") && method === "POST") {
    const fork = { name: body.name, fork: true, parent: { full_name: pathname.split("/").slice(2, 4).join("/") } };
    orgRepos.push(fork);
    return response(fork, 202);
  }
  if (pathname.includes("/git/blobs/") && method === "GET") {
    const content = blobs.get(pathname.split("/").at(-1));
    return content === undefined ? response({ message: "Not Found" }, 404) : response({ content: Buffer.from(content).toString("base64"), encoding: "base64" });
  }
  if (pathname.endsWith("/git/blobs") && method === "POST") {
    const content = Buffer.from(body.content, "base64").toString();
    const sha = blobSha(content);
    blobs.set(sha, content);
    return response({ sha }, 201);
  }
  if (pathname.includes("/git/trees/") && method === "GET") {
    const sha = pathname.split("/").at(-1);
    return response({ sha, tree: trees.get(sha), truncated: false });
  }
  if (pathname.endsWith("/git/trees") && method === "POST") {
    const files = new Map((trees.get(body.base_tree) || []).map((item) => [item.path, item]));
    for (const item of body.tree) {
      if (item.type === "tree") {
        for (const nested of trees.get(item.sha) || []) files.set(`${item.path}/${nested.path}`, { ...nested, path: `${item.path}/${nested.path}` });
      } else files.set(item.path, { ...item, size: Buffer.byteLength(blobs.get(item.sha) || "") });
    }
    const sha = `tree-${++sequence}`;
    trees.set(sha, [...files.values()]);
    return response({ sha }, 201);
  }
  if (pathname.includes("/git/commits/") && method === "GET") return response({ tree: { sha: commits.get(pathname.split("/").at(-1)) } });
  if (pathname.endsWith("/git/commits") && method === "POST") {
    const sha = `commit-${++sequence}`;
    commits.set(sha, body.tree);
    return response({ sha }, 201);
  }
  if (pathname.includes("/git/ref/heads/") && method === "GET") return response({ object: { sha: head } });
  if (pathname.includes("/git/refs/heads/") && method === "PATCH") {
    head = body.sha;
    return response({ object: { sha: head } });
  }
  if (pathname.endsWith("/pages")) {
    if (method === "GET") return pages ? response(pages) : response({ message: "Not Found" }, 404);
    pages = { source: body.source };
    return response(pages, method === "POST" ? 201 : 204);
  }
  if (pathname.includes("/contents/")) {
    const prefix = pathname.split("/contents/")[1];
    const directory = prefix ? `${prefix}/` : "";
    return response(initialFiles.filter((file) => file.path.startsWith(directory) && !file.path.slice(directory.length).includes("/")).map((file) => ({ ...file, type: "file" })));
  }
  if (method === "DELETE") return response(null, 204);
  if (/^\/repos\/[^/]+\/[^/]+$/.test(pathname)) {
    const repo = orgRepos.find((item) => item.name === pathname.split("/").at(-1));
    return response(repo || { name: "Alice-game", html_url: "https://github.com/WebRPG-org/Alice-game", default_branch: "main", fork: false, size: 10, ...fixture.repo });
  }
  throw new Error(`Unexpected request: ${method} ${url}`);
};

process.on("exit", () => {
  const files = Object.fromEntries((trees.get(commits.get(head)) || initialFiles).map((item) => [item.path, blobs.get(item.sha)]));
  fs.writeFileSync(process.env.TEST_SNAPSHOT, JSON.stringify({ files, requests, orgRepos }));
});
