import test from "node:test";
import assert from "node:assert/strict";
import { injectGameShell, SHELL_HEAD_START, SHELL_BODY_START } from "../scripts/game-shell-html.mjs";

const raw='<html lang="ja"><head><title>旧标题</title><meta name="viewport" content="width=device-width"></head><body class="rpg"><script src="js/main.js"></script><canvas id="GameCanvas"></canvas></body></html>';
const entry={id:"owner-game",title:"Old game"};
const match={slug:"narcissu",instance:{title:"Narcissu 中文版"}};
test("injects one no-framework shell before the original game DOM",()=>{
  const r=injectGameShell(raw,{entry,match});
  assert.equal(r.status,"enhanced");
  assert.match(r.html,/webrpg\.org\/tookit\/shell\.css/);
  assert.match(r.html,/<details id="webrpg-shell"/);
  assert.match(r.html,/https:\/\/webrpg\.org\/ja\/game\/narcissu\//);
  assert.match(r.html,/<script src="https:\/\/webrpg\.org\/tookit\/shell\.js"><\/script>/);
  assert.ok(r.html.indexOf('id="webrpg-shell"')<r.html.indexOf('<script src="js/main.js">'));
  assert.ok(r.html.indexOf('tookit/shell.js')<r.html.indexOf('<script src="js/main.js">'));
  assert.equal((r.html.match(/id="webrpg-shell"/g)||[]).length,1);
  assert.equal((r.html.match(/id="webrpg-touch-controls"/g)||[]).length,1);
  assert.match(r.html,/<body class="rpg">/);
  assert.ok(r.html.endsWith('<script src="js/main.js"></script><canvas id="GameCanvas"></canvas></body></html>'));
});
test("second injection is byte-identical and reports unchanged",()=>{
 const a=injectGameShell(raw,{entry,match});
 const b=injectGameShell(a.html,{entry,match});
 assert.equal(b.status,"unchanged");assert.equal(b.html,a.html);
 assert.equal((b.html.match(/WebRPG Shell:START/g)||[]).length,1);
 assert.equal((b.html.match(/WebRPG Shell Head:START/g)||[]).length,1);
});
test("updates existing Game identity and title in place rather than duplicating markup",()=>{
 const a=injectGameShell(raw,{entry,match});
 const b=injectGameShell(a.html,{entry:{id:"owner-game",title:"Old"},match:{slug:"other-game",instance:{title:"Game v2"}}});
 assert.equal(b.status,"enhanced");
 assert.match(b.html,/Game v2/);assert.match(b.html,/\/ja\/game\/other-game\//);
 assert.doesNotMatch(b.html,/\/en\/game\/narcissu\//);
 assert.equal((b.html.match(/WebRPG Shell:START/g)||[]).length,1);
});
test("missing/ambiguous Game relationship does not fabricate a detail page",()=>{
 const a=injectGameShell(raw,{entry});
 assert.equal(a.status,"enhanced");
 assert.doesNotMatch(a.html,/\/en\/game\//);
 assert.match(a.html,/href="https:\/\/webrpg\.org\/"/);
 assert.match(a.html,/<summary/);
 assert.match(a.html,/hidden title="Enter fullscreen"/);
});
test("escapes untrusted instance title and id",()=>{
 const a=injectGameShell(raw,{entry:{id:'x"><img src=x>',title:'<script>alert(1)</script>'},match:{slug:"narcissu",instance:{title:'Narcissu " <&'}}});
 assert.match(a.html,/Narcissu &quot; &lt;&amp;/);
 assert.doesNotMatch(a.html,/<script>alert\(1\)<\/script>/);
 assert.doesNotMatch(a.html,/data-instance="x"><img src=x>/);
});
test("broken markers and missing structural tags are conservatively skipped",()=>{
 assert.equal(injectGameShell("<html><head></head></html>",{entry}).status,"no-head-or-body");
 assert.equal(injectGameShell(raw.replace('<title>旧标题</title>',SHELL_HEAD_START),{entry}).status,"broken-markers");
 assert.equal(injectGameShell(raw.replace('<body class="rpg">',SHELL_BODY_START+'<body class="rpg">'),{entry}).status,"broken-markers");
});
test("does not require edits to games.json and respects arbitrary language headings",()=>{
 const a=injectGameShell(raw,{entry,match});
 assert.match(a.html,/<html lang="ja">/);
 assert.match(a.html,/<title>旧标题<\/title>/);
 assert.match(a.html,/id="webrpg-touch-controls"[^>]*hidden/);
 assert.match(a.html,/data-wr-action="gamepad" hidden/);
});
