import path from "node:path";

export const DATABASE_FILES = ["Actors", "Classes", "Skills", "Items", "Weapons", "Armors", "Enemies", "Troops", "States", "Animations", "Tilesets", "CommonEvents", "System", "MapInfos"].map((name) => `data/${name}.json`);

export function runtimeFiles(engine) {
  const prefix = engine === "RPG Maker MZ" ? "rmmz" : "rpg";
  return ["core", "managers", "objects", "scenes", "sprites", "windows"].map((name) => `js/${prefix}_${name}.js`).concat("js/plugins.js", "js/main.js");
}

export function getScriptSources(html) {
  return [...String(html).replace(/<!--[\s\S]*?-->/g, "").matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)].map((match) => match[1].trim());
}

export function resolveRepoReference(fromPath, reference) {
  if (!reference || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(reference)) return null;
  let decoded;
  try { decoded = decodeURIComponent(reference.split(/[?#]/, 1)[0]); } catch { return null; }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), decoded.replace(/\\/g, "/")));
  return resolved.startsWith("../") || resolved === ".." ? null : resolved;
}

// MZ's main.js loads its runtime through scriptUrls instead of HTML tags.
export function getStartupScripts(html, mainContent = "") {
  const direct = getScriptSources(html);
  const array = mainContent.match(/\bscriptUrls\s*=\s*\[([\s\S]*?)\]/)?.[1] || "";
  const dynamic = [...array.matchAll(/["']([^"']+\.js(?:[?#][^"']*)?)["']/g)].map((match) => match[1]);
  return { direct, dynamic };
}

export function validateEntry({ html, mainContent, engine, entryPath, projectRoot, files }) {
  const paths = new Set(files.map((file) => file.path));
  const required = runtimeFiles(engine).concat(DATABASE_FILES).map((file) => `${projectRoot}${file}`);
  const missing = required.filter((file) => !paths.has(file));
  const { direct, dynamic } = getStartupScripts(html, mainContent);
  const directPaths = direct.map((src) => resolveRepoReference(entryPath, src));
  // scriptUrls paths are relative to the document, not to js/main.js.
  const startupPaths = new Set(directPaths.concat(dynamic.map((src) => resolveRepoReference(entryPath, src))).filter(Boolean));
  const notLoaded = runtimeFiles(engine).filter((file) => !startupPaths.has(`${projectRoot}${file}`));
  const badReferences = direct.concat(dynamic).filter((src) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) return false;
    const resolved = resolveRepoReference(entryPath, src);
    return !resolved || !paths.has(resolved);
  });
  if (!directPaths.includes(`${projectRoot}js/main.js`)) notLoaded.push("HTML does not load js/main.js");
  if (missing.length || notLoaded.length || badReferences.length) {
    return { valid: false, reason: [missing.length && `Missing files: ${missing.join(", ")}`, notLoaded.length && `Startup does not load: ${notLoaded.join(", ")}`, badReferences.length && `Unresolved script references: ${badReferences.join(", ")}`].filter(Boolean).join("; ") };
  }
  return { valid: true, reason: "" };
}

export function detectRpgMakerProject(files, htmlByPath, mainByPath) {
  const candidates = [];
  for (const file of files) {
    const match = file.path.match(/js\/(rpg|rmmz)_core\.js$/i);
    if (!match) continue;
    const projectRoot = file.path.slice(0, -match[0].length);
    const engine = match[1].toLowerCase() === "rmmz" ? "RPG Maker MZ" : "RPG Maker MV";
    for (const [entryPath, html] of htmlByPath) {
      if (!getScriptSources(html).some((src) => resolveRepoReference(entryPath, src) === `${projectRoot}js/main.js`)) continue;
      const validation = validateEntry({ html, mainContent: mainByPath.get(`${projectRoot}js/main.js`) || "", engine, entryPath, projectRoot, files });
      const signals = runtimeFiles(engine).filter((name) => files.some((item) => item.path === `${projectRoot}${name}`));
      const score = signals.length * 5 + (validation.valid ? 60 : 0) + (/\bindex\.html$/i.test(entryPath) ? 8 : 0);
      candidates.push({ ...validation, engine, entryPath, projectRoot, score, signals, htmlPathsToPatch: [entryPath] });
    }
  }
  candidates.sort((a, b) => Number(b.valid) - Number(a.valid) || b.score - a.score || a.entryPath.localeCompare(b.entryPath, "en"));
  const best = candidates[0];
  if (best?.valid) best.htmlPathsToPatch = [...new Set(candidates.filter((item) => item.valid && item.engine === best.engine && item.projectRoot === best.projectRoot).map((item) => item.entryPath))];
  return best || { valid: false, score: 0, signals: [], reason: "No RPG Maker MV/MZ HTML entry point loading js/main.js was found." };
}

export function looksLikeRpgMakerEntry(html, engine) {
  const scripts = getScriptSources(html);
  const prefix = engine === "RPG Maker MZ" ? "rmmz" : "rpg";
  return scripts.some((src) => /(?:^|\/)js\/main\.js(?:[?#]|$)/i.test(src)) && (engine === "RPG Maker MZ" || scripts.some((src) => new RegExp(`(?:^|/)js/${prefix}_core\\.js(?:[?#]|$)`, "i").test(src)));
}

export function flattenEntries(tree, projectRoot) {
  const prefix = projectRoot.toLowerCase();
  const outside = tree.filter((item) => item.type === "blob" && !item.path.toLowerCase().startsWith(prefix));
  const inside = tree.filter((item) => item.type === "blob" && item.path.toLowerCase().startsWith(prefix));
  if (!inside.length) throw new Error(`Flatten failed: no files under project root "${projectRoot}".`);
  const entries = new Map(outside.map((item) => [item.path, { path: item.path, sha: item.sha, mode: item.mode, type: item.type }]));
  for (const item of inside) {
    const destination = item.path.slice(projectRoot.length);
    if (!destination) continue;
    // A file/directory collision cannot preserve both paths; leave the fork
    // untouched and report an error rather than discarding unrelated content.
    if ([...entries.keys()].some((name) => name.startsWith(`${destination}/`) || destination.startsWith(`${name}/`))) {
      throw new Error(`Flatten path conflicts with an existing file or directory: ${destination}`);
    }
    entries.set(destination, { path: destination, sha: item.sha, mode: item.mode, type: item.type });
  }
  return [...entries.values()];
}
