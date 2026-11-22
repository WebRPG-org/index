export const SEO_START = "<!-- WebRPG SEO:START -->";
export const SEO_END = "<!-- WebRPG SEO:END -->";
const LOCALES = new Set(["en", "ja", "zh-Hans"]);
const OG_LOCALES = { en: "en_US", ja: "ja_JP", "zh-Hans": "zh_CN" };
const LANG_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const PLACEHOLDER = /^(?:game|new game|rpg maker(?: mv| mz)?|index|untitled|__template__|test(?: game)?)$/i;

export function buildInstanceIndex(registry) {
  const map = new Map();
  if (!registry?.games || typeof registry.games !== "object") return map;
  for (const [slug, game] of Object.entries(registry.games)) {
    for (const instance of game?.instances || []) {
      if (instance?.type !== "internal" || typeof instance.id !== "string") continue;
      map.set(instance.id, map.has(instance.id) ? null : { slug, game, instance });
    }
  }
  return map;
}

const tidy = (x) => typeof x === "string" ? x.replace(/\s+/g, " ").trim() : "";
const escapeHtml = (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function attribute(tag, name) {
  const re = new RegExp("\\s" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i");
  const m = tag.match(re);
  return m ? (m[1] ?? m[2] ?? m[3]) : "";
}

function hasTag(head, tag, key, value) {
  return [...head.matchAll(new RegExp("<" + tag + "\\b[^>]*>", "gi"))]
    .some((m) => {
      const found = attribute(m[0], key).toLowerCase();
      return tag === "link" && key === "rel"
        ? found.split(/\s+/).includes(value.toLowerCase())
        : found === value.toLowerCase();
    });
}

function getLang(html) {
  return tidy(attribute(html.match(/<html\b[^>]*>/i)?.[0] || "", "lang"));
}

function getLanguages(match) {
  if (!Array.isArray(match?.instance?.languages)) return [];
  return [...new Set(match.instance.languages.filter((x) => typeof x === "string" && LANG_RE.test(x)))];
}

function selectLocale(langs, originalLang) {
  const html = langs.length === 1 ? langs[0]
    : langs.length > 1 ? (langs.includes(originalLang) ? originalLang : "und")
    : (LANG_RE.test(originalLang) ? originalLang : "und");
  return { html, description: LOCALES.has(html) ? html : "en" };
}

function secureUrl(raw, siteOrigin) {
  try {
    const url = new URL(raw), site = new URL(siteOrigin);
    return url.protocol === "https:" && url.origin === site.origin &&
      url.pathname !== "/" && !url.search && !url.hash ? url.href : "";
  } catch { return ""; }
}

function secureImage(raw) {
  try { const url = new URL(raw); return url.protocol === "https:" ? url.href : ""; }
  catch { return ""; }
}

function getTitle(entry, match, head, savedTitle = "") {
  const authored = tidy(head.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || savedTitle).replace(/&amp;/gi, "&");
  const candidate = tidy(match?.instance?.title) || tidy(match?.game?.originalTitle) ||
    (tidy(entry?.title) && !PLACEHOLDER.test(tidy(entry.title)) ? tidy(entry.title) : "") ||
    (!PLACEHOLDER.test(authored) ? authored : "");
  return candidate ? candidate.replace(/\s*[|｜]\s*WebRPG\s*$/i, "").trim() + " | WebRPG" : "";
}

const DESCRIPTION_LIMITS = { en: 170, "zh-Hans": 110, ja: 125 };

// Use complete sentences or clauses instead of blindly cutting a game summary
// mid-word/mid-sentence. If no meaningful boundary fits, keep the original
// summary rather than emit an awkward or misleading fragment.
function summarizeForMeta(summary, available, lang) {
  if (summary.length <= available) return summary;
  const minimum = Math.min(Math.floor(available * .4), lang === "en" ? 48 : 27);
  const chooseBoundary = (pattern) => {
    let best = "";
    for (const match of summary.matchAll(pattern)) {
      const end = match.index + match[0].length;
      const candidate = tidy(summary.slice(0, end));
      if (candidate.length >= minimum && candidate.length <= available) best = candidate;
    }
    return best;
  };
  const sentence = chooseBoundary(lang === "en" ? /[.!?](?=\s|$)/g : /[。！？.!?]/g);
  if (sentence) return sentence;
  const clause = chooseBoundary(lang === "en" ? /[;:](?=\s|$)|,(?=\s)/g : /[；：，、]/g);
  if (!clause) return summary;
  return lang === "en" ? clause.replace(/[,;:]$/, ".") : clause.replace(/[，、；：]$/, "。");
}

function optimizeMetaDescription(summary, title, lang) {
  if (!title || PLACEHOLDER.test(title)) return summary;
  const prefix = lang === "zh-Hans"
    ? `在 WebRPG 在线游玩《${title}》。`
    : lang === "ja"
      ? `「${title}」をWebRPGでブラウザーからプレイ。`
      : `Play ${title} online in your browser on WebRPG.`;
  // The existing summary remains the source of all game-specific claims.
  // A length target is a soft preference, not a reason to damage the copy.
  const available = (DESCRIPTION_LIMITS[lang] || DESCRIPTION_LIMITS.en) - prefix.length - 1;
  const excerpt = available >= 40 ? summarizeForMeta(summary, available, lang) : summary;
  return `${prefix} ${excerpt}`;
}

function getDescription(game, lang, baseTitle, engine) {
  if (game) {
    for (const locale of [...new Set([lang, "en", "ja", "zh-Hans"])]) {
      const summary = tidy(game.introductions?.[locale]?.summary);
      if (summary && !/^(?:tbd|todo|lorem ipsum|待补充|暂无介绍)$/i.test(summary)) {
        return { text: optimizeMetaDescription(summary, baseTitle, locale), lang: locale };
      }
    }
  }
  if (!baseTitle || PLACEHOLDER.test(baseTitle)) return { text: "", lang: "en" };
  return { text: `Play ${baseTitle} online in your browser on WebRPG. A ${tidy(engine) || "RPG Maker"} game.`, lang: "en" };
}

// Safe/idempotent: only touches <html lang>, <head> metadata, never game scripts or visible layout.
export function enhanceGameEntryHTML(html, { entry, match = null, playUrl, siteOrigin = "https://webrpg.org", engine = "", coverUrl = "" }) {
  const canonical = secureUrl(playUrl, siteOrigin);
  if (!canonical) return { html, changed: false, status: "invalid-canonical" };
  const found = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/i.exec(html);
  if (!found) return { html, changed: false, status: "no-complete-head" };

  const original = found[1];
  const starts = original.split(SEO_START).length - 1, ends = original.split(SEO_END).length - 1;
  if (starts !== ends || starts > 1) return { html, changed: false, status: "invalid-managed-markers" };
  const cleaned = starts ? original.replace(new RegExp(escapeRe(SEO_START) + "[\\s\\S]*?" + escapeRe(SEO_END) + "\\s*"), "") : original;

  // An authored canonical pointing elsewhere is a deliberate indexing choice.
  // Do not create self-referencing OG/JSON-LD that contradicts it.
  const authoredCanonical = [...cleaned.matchAll(/<link\b[^>]*>/gi)]
    .find((m) => attribute(m[0], "rel").toLowerCase().split(/\s+/).includes("canonical"));
  if (authoredCanonical) {
    try {
      if (new URL(attribute(authoredCanonical[0], "href"), canonical).href !== canonical) {
        return { html, changed: false, status: "authored-canonical-conflict" };
      }
    } catch {
      return { html, changed: false, status: "authored-canonical-conflict" };
    }
  }

  const langs = getLanguages(match);
  const chosen = selectLocale(langs, getLang(html));
  const savedTitle = original.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || "";
  const title = getTitle(entry, match, cleaned, savedTitle);
  const description = getDescription(match?.game, chosen.description, title.replace(/\s*[|｜]\s*WebRPG$/i, ""), engine);
  const cover = secureImage(match?.game?.media?.cover || coverUrl);

  // Preserve author-managed meta/canonical/robots/OG when already present.
  const head = title ? cleaned.replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>\s{0,8}/gi, "") : cleaned;
  const tags = [];
  if (title) tags.push(`<title>${escapeHtml(title)}</title>`);
  if (description.text && !hasTag(head, "meta", "name", "description")) {
    tags.push(`<meta name="description" content="${escapeHtml(description.text)}">`);
  }
  if (!hasTag(head, "link", "rel", "canonical")) tags.push(`<link rel="canonical" href="${escapeHtml(canonical)}">`);
  for (const [key, value] of [
    ["og:type", "website"], ["og:site_name", "WebRPG"], ["og:title", title],
    ["og:description", description.text], ["og:url", canonical], ["og:image", cover],
    ["og:locale", description.lang === chosen.html ? OG_LOCALES[chosen.html] : ""],
  ]) {
    if (value && !hasTag(head, "meta", "property", key)) tags.push(`<meta property="${key}" content="${escapeHtml(value)}">`);
  }
  const schema = {
    "@context": "https://schema.org", "@type": "WebPage",
    "@id": canonical + "#webrpg-play-page", url: canonical,
    name: title || tidy(entry?.title) || "WebRPG game",
    ...(description.text ? { description: description.text } : {}),
    ...(langs.length ? { inLanguage: langs } : chosen.html !== "und" ? { inLanguage: chosen.html } : {}),
    isPartOf: { "@type": "WebSite", "@id": "https://webrpg.org/#website", name: "WebRPG", url: "https://webrpg.org/" },
    ...(match && /^[a-z0-9][a-z0-9-]*$/i.test(match.slug) ? {
      about: { "@type": "VideoGame", "@id": `https://webrpg.org/en/game/${encodeURIComponent(match.slug)}/#game`, name: tidy(match.game.originalTitle) || tidy(match.instance.title) },
      relatedLink: `https://webrpg.org/en/game/${encodeURIComponent(match.slug)}/`,
    } : {}),
  };
  tags.push(`<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, "\\u003c")}</script>`);

  const nl = html.includes("\r\n") ? "\r\n" : "\n";
  const close = found[0].match(/<\/head\s*>$/i)?.[0] || "</head>";
  const open = found[0].slice(0, found[0].length - original.length - close.length);
  const nextHead = `${open}${head.trimEnd()}${nl}${[SEO_START, ...tags, SEO_END].join(nl)}${nl}${close}`;
  let next = html.slice(0, found.index) + nextHead + html.slice(found.index + found[0].length);
  next = next.replace(/<html\b[^>]*>/i, (opening) => /\slang\s*=/i.test(opening)
    ? opening.replace(/\slang\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, ` lang="${escapeHtml(chosen.html)}"`)
    : opening.replace(/>$/, ` lang="${escapeHtml(chosen.html)}">`));
  return { html: next, changed: next !== html, status: next === html ? "unchanged" : "enhanced",
    gameSlug: match?.slug || null, htmlLanguage: chosen.html, metaLanguage: description.lang };
}
