import test from "node:test";
import assert from "node:assert/strict";
import { buildInstanceIndex, enhanceGameEntryHTML, SEO_START, SEO_END } from "../scripts/game-page-seo.mjs";

const registry = { registryVersion: 1, games: {
  narcissu: {
    originalTitle: "ナルキッソス",
    translatedTitles: { en: "Narcissu", "zh-Hans": "水仙" },
    introductions: {
      en: { summary: "A visual novel about life and death." },
      ja: { summary: "ナルキッソスの物語。" },
      "zh-Hans": { summary: "关于生命与死亡的视觉小说。" },
    },
    media: { cover: "https://webrpg.org/Narcissu/cover.png" },
    instances: [
      { type: "internal", id: "narcissu-zh", title: "Narcissu（中文版）", languages: ["zh-Hans"] },
      { type: "internal", id: "narcissu-pt", title: "Narcissu Português", languages: ["pt"] },
      { type: "internal", id: "narcissu-multi", title: "Narcissu International", languages: ["en", "ja"] },
      { type: "external", id: "narcissu-offsite", title: "Offsite", languages: ["en"] },
    ],
  },
} };
const map = buildInstanceIndex(registry);
const baseEntry = { id: "narcissu-zh", title: "Narcissu" };
const html = '<!doctype html><html><head>\n<meta name="viewport" content="user-scalable=no">\n<title>Original Name</title>\n</head><body><script src="js/main.js"></script></body></html>';
const apply = (id, content = html, extra = {}) => enhanceGameEntryHTML(content, {
  entry: { ...baseEntry, id },
  match: map.get(id),
  playUrl: "https://webrpg.org/Narcissu/",
  engine: "RPG Maker MV",
  ...extra,
});

test("index matches only internal instances and rejects duplicates", () => {
  assert.equal(map.size, 3);
  assert.equal(map.get("narcissu-zh").slug, "narcissu");
  assert.equal(map.get("narcissu-offsite"), undefined);
  const corrupt = JSON.parse(JSON.stringify(registry));
  corrupt.games.second = { instances: [{ type: "internal", id: "narcissu-zh" }] };
  assert.equal(buildInstanceIndex(corrupt).get("narcissu-zh"), null);
});

test("Chinese game has localized title, description and actual gameplay language", () => {
  const result = apply("narcissu-zh");
  assert.equal(result.status, "enhanced");
  assert.match(result.html, /<html lang="zh-Hans">/);
  assert.match(result.html, /<title>Narcissu（中文版） \| WebRPG<\/title>/);
  assert.match(result.html, /content="在 WebRPG 在线游玩《Narcissu（中文版）》。 关于生命与死亡的视觉小说。"/);
  assert.match(result.html, /content="zh_CN"/);
  assert.match(result.html, /href="https:\/\/webrpg.org\/Narcissu\/"/);
  assert.match(result.html, /https:\/\/webrpg.org\/en\/game\/narcissu\/#game/);
  assert.match(result.html, /<script src="js\/main.js"><\/script>/);
  assert.equal((result.html.match(/<title>/g) || []).length, 1);
  assert.equal((result.html.match(/name="description"/g) || []).length, 1);
  assert.equal((result.html.match(/rel="canonical"/g) || []).length, 1);
  assert.deepEqual(JSON.parse(result.html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)[1]).inLanguage, ["zh-Hans"]);
});

test("Other-language game is not mislabelled as English", () => {
  const result = apply("narcissu-pt");
  assert.match(result.html, /<html lang="pt">/);
  assert.match(result.html, /content="Play Narcissu Português online in your browser on WebRPG. A visual novel about life and death\."/);
  assert.doesNotMatch(result.html, /property="og:locale"/);
  assert.match(result.html, /<title>Narcissu Português \| WebRPG<\/title>/);
});

test("Multi-language without confirmed default language gets und; existing supported lang is honored", () => {
  assert.match(apply("narcissu-multi").html, /<html lang="und">/);
  const explicit = apply("narcissu-multi", html.replace("<html>", '<html lang="ja">'));
  assert.match(explicit.html, /<html lang="ja">/);
  assert.match(explicit.html, /content="「Narcissu International」をWebRPGでブラウザーからプレイ。 ナルキッソスの物語。"/);
});

test("Repeated injection is byte-identical including unknown games", () => {
  for(const id of ["narcissu-zh", "unknown"]) {
    const input = id === "unknown" ? { entry: { id, title: "__template__" }, match: null, playUrl: "https://webrpg.org/Unknown/", engine: "RPG Maker MV" } : null;
    const first = input ? enhanceGameEntryHTML(html, input) : apply(id);
    const second = input ? enhanceGameEntryHTML(first.html, input) : apply(id, first.html);
    assert.equal(first.html, second.html);
    assert.equal(second.changed, false);
    assert.equal((first.html.match(/WebRPG SEO:START/g) || []).length, 1);
  }
});

test("Author description, canonical, robots, OG survive without duplicates", () => {
  const authored = html.replace("</head>", `<meta name="description" content="Author copy"><link rel="canonical" href="https://webrpg.org/Narcissu/"><meta name="robots" content="noindex"><meta property="og:title" content="Author OG"></head>`);
  const result = apply("narcissu-zh", authored);
  assert.equal((result.html.match(/name="description"/g) || []).length, 1);
  assert.equal((result.html.match(/rel="canonical"/g) || []).length, 1);
  assert.equal((result.html.match(/property="og:title"/g) || []).length, 1);
  assert.match(result.html, /Author copy/);
  assert.match(result.html, /https:\/\/webrpg.org\/Narcissu\//);
  assert.match(result.html, /name="robots" content="noindex"/);
});

test("Conflicting author canonical is respected by declining to rewrite the page", () => {
  const source = html.replace("</head>", '<link rel="canonical" href="https://original.example/game"></head>');
  const result = apply("narcissu-zh", source);
  assert.equal(result.status, "authored-canonical-conflict");
  assert.equal(result.html, source);
});

test("Special HTML in titles is escaped, JSON-LD cannot inject a script", () => {
  const dangerous = {
    entry: { id: "other", title: 'A & B <script>alert("x")</script>' },
    match: null,
    playUrl: "https://webrpg.org/fork/game.html",
    engine: "RPG Maker MZ",
  };
  const result = enhanceGameEntryHTML(html, dangerous);
  assert.match(result.html, /A &amp; B &lt;script&gt;/);
  assert.equal((result.html.match(/type="application\/ld\+json"/g) || []).length, 1);
  assert.doesNotMatch(result.html, /<script>alert/);
  assert.match(result.html, /game\.html/);
});

test("Invalid URLs, invalid markers or missing head are not mutated", () => {
  const invalid = enhanceGameEntryHTML(html, { entry: baseEntry, match: map.get("narcissu-zh"), playUrl: "https://evil.invalid/" });
  assert.equal(invalid.status, "invalid-canonical");
  assert.equal(invalid.html, html);
  assert.equal(apply("narcissu-zh", "<html></html>").status, "no-complete-head");
  const broken = html.replace("</head>", `${SEO_START}<title>X</title></head>`);
  assert.equal(apply("narcissu-zh", broken).status, "invalid-managed-markers");
  assert.equal((apply("narcissu-zh").html.match(new RegExp(SEO_END, "g")) || []).length, 1);
});

test("Long English summaries use an intact sentence while preserving search intent", () => {
  const game = structuredClone(registry.games.narcissu);
  const sentence = "A fantasy RPG set in a mysterious town where two travelers search for a lost friend.";
  game.introductions.en.summary = sentence + " The story continues across ancient ruins, hidden valleys, and many dangerous encounters with unusual characters.";
  const result = apply("narcissu-pt", html, { match: { slug: "narcissu", game, instance: registry.games.narcissu.instances[1] } });
  const meta = result.html.match(/<meta name="description" content="([^"]+)">/)[1];
  assert.ok(meta.startsWith("Play Narcissu Português online in your browser on WebRPG."));
  assert.ok(meta.endsWith(sentence));
  assert.ok(meta.length <= 170);
  assert.ok(!meta.includes("The story continues"));
  const graph = JSON.parse(result.html.split('<script type="application/ld+json">')[1].split("</script>")[0]);
  assert.equal(graph.description, meta);
  assert.ok(result.html.includes(`<meta property="og:description" content="${meta}">`));
});

test("Chinese SEO excerpts preserve complete clauses rather than cutting words", () => {
  const game = structuredClone(registry.games.narcissu);
  const sentence = "讲述两名旅人在一座神秘的古城相遇并寻找失落记忆的奇幻冒险故事。";
  game.introductions["zh-Hans"].summary = sentence + "之后他们必须穿越危机四伏的森林和地牢，面对未知的敌人与艰难抉择，最终发现古城隐藏多年的秘密。".repeat(3);
  const result = apply("narcissu-zh", html, { match: { slug: "narcissu", game, instance: registry.games.narcissu.instances[0] } });
  const meta = result.html.match(/<meta name="description" content="([^"]+)">/)[1];
  assert.match(meta, /^在 WebRPG 在线游玩《Narcissu（中文版）》/);
  assert.ok(meta.includes(sentence));
  assert.ok(meta.endsWith("。"));
  assert.ok(meta.length <= 110);
});

test("When no meaningful boundary exists, the original summary stays intact", () => {
  const game = structuredClone(registry.games.narcissu);
  const longUnpunctuated = ("A mysterious adventure with a long original introduction ").repeat(5).trim();
  game.introductions.en.summary = longUnpunctuated;
  const result = apply("narcissu-pt", html, { match: { slug: "narcissu", game, instance: registry.games.narcissu.instances[1] } });
  const meta = result.html.match(/<meta name="description" content="([^"]+)">/)[1];
  assert.ok(meta.endsWith(longUnpunctuated));
  assert.ok(meta.includes("Play Narcissu Português online"));
});

test("Original viewport, game scripts and all body markup are preserved exactly", () => {
  const result = apply("narcissu-zh");
  assert.equal(result.html.slice(result.html.indexOf("<body>")), html.slice(html.indexOf("<body>")));
  assert.match(result.html, /meta name="viewport" content="user-scalable=no"/);
});
