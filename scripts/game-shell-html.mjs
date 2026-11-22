// Build-time HTML injector for the native Game Shell (no runtime framework).
export const SHELL_HEAD_START = "<!-- WebRPG Shell Head:START -->";
export const SHELL_HEAD_END = "<!-- WebRPG Shell Head:END -->";
export const SHELL_BODY_START = "<!-- WebRPG Shell:START -->";
export const SHELL_BODY_END = "<!-- WebRPG Shell:END -->";
export const SHELL_CSS_URL = "https://webrpg.org/tookit/shell.css";
export const SHELL_JS_URL = "https://webrpg.org/tookit/shell.js";
const LOGO_URL = "https://webrpg.org/assets/logo.png";
const HOME_URL = "https://webrpg.org/";
const SLUG = /^[a-z0-9][a-z0-9-]*$/i;

const escapeHtml = (s) => String(s).replace(/&/g,"&amp;")
  .replace(/</g,"&lt;").replace(/>/g,"&gt;")
  .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
const newlineOf = (s) => s.includes("\r\n") ? "\r\n" : "\n";
function replaceRegion(html, first, last, replacement) {
  const a=html.indexOf(first), b=html.indexOf(last);
  if ((a<0)!==(b<0)) return { error: "broken-markers" };
  if (a<0) return { html, found:false };
  if (a!==html.lastIndexOf(first)||b!==html.lastIndexOf(last)||b<a) return { error: "duplicate-markers" };
  return {html:html.slice(0,a)+replacement+html.slice(b+last.length),found:true};
}
function icon(paths) {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+paths+'"/></svg>';
}
const HOME_ICON=icon("M3 10.5 12 3l9 7.5V21h-6v-7H9v7H3z");
const DETAIL_ICON=icon("M12 6c-2.4-2-5.2-2.5-9-1v15c3-1.3 6.2-.9 9 1 2.8-1.9 6-2.3 9-1V5c-3.8-1.5-6.6-1-9 1Zm0 0v15");
const FULL_ICON='<svg viewBox="0 0 24 24" aria-hidden="true"><path class="wr-fs-enter" d="M4 9V4h5m6 0h5v5M20 15v5h-5M9 20H4v-5"/><path class="wr-fs-exit" d="M9 4v5H4m11-5v5h5M20 15h5v5M4 15h5v5"/></svg>';
const ROTATE_ICON=icon("M7.1 3.5h9.8a2.1 2.1 0 0 1 2.1 2.1v12.8a2.1 2.1 0 0 1-2.1 2.1H7.1A2.1 2.1 0 0 1 5 18.4V5.6A2.1 2.1 0 0 1 7.1 3.5Z M4 8a8.5 8.5 0 0 1 15-2 M19 6V2.6 M19 6h-3");
const PAD_ICON=icon("M7 8h10a4.2 4.2 0 0 1 4 3.4l1 5.4a2.3 2.3 0 0 1-3.5 2.3l-2.7-1.8H8.2l-2.7 1.8A2.3 2.3 0 0 1 2 16.8l1-5.4A4.2 4.2 0 0 1 7 8Z M7.5 11.5v5 M5 14h5 M16 12h.01 M18.5 14.5h.01");
function actionIcon(id, iconSvg, label, mobile = false) {
  return '<button type="button" class="wr-action'+(mobile?' wr-mobile-tool':'')+'" data-wr-action="'+id+'" hidden title="'+label+'" aria-label="'+label+'" aria-pressed="false">'+
    iconSvg+'<span class="wr-sr-only" lang="en">'+label+'</span></button>';
}
function navLink(url, svg, label) {
  return '<a class="wr-link" href="'+escapeHtml(url)+'" title="'+label+'" aria-label="'+label+'">'+svg+'<span class="wr-sr-only" lang="en">'+label+'</span></a>';
}
function controlButton(name, label, text) {
  return '<button type="button" class="wr-pad-key" data-wr-key="'+name+'" aria-label="'+escapeHtml(label)+
    '" title="'+escapeHtml(label)+'" aria-pressed="false">'+escapeHtml(text)+'</button>';
}
function buildControls() {
  return '<div id="webrpg-touch-controls" hidden role="group" aria-label="RPG Maker virtual controller">'+
    '<div class="wr-pad-cluster wr-dpad" role="group" aria-label="Movement">'+
    controlButton("up","Move up","↑")+controlButton("left","Move left","←")+
    controlButton("right","Move right","→")+controlButton("down","Move down","↓")+'</div>'+
    '<div class="wr-pad-cluster wr-pad-actions" role="group" aria-label="Actions">'+
    controlButton("pageup","Previous page (Q)","L")+controlButton("pagedown","Next page (W)","R")+
    controlButton("shift","Run (hold Shift)","RUN")+controlButton("cancel","Cancel or menu (Escape)","B")+
    controlButton("ok","Confirm (Enter)","A")+'</div></div>';
}
function buildShell({ title, gameSlug, instanceId, detailLocale }) {
  const detail = gameSlug && SLUG.test(gameSlug)
    ? navLink("https://webrpg.org/"+detailLocale+"/game/"+encodeURIComponent(gameSlug)+"/",DETAIL_ICON,"Game details") : "";
  return '<details id="webrpg-shell" data-phase="intro" data-menu-direction="down"'+
    ' data-game="'+escapeHtml(gameSlug||"")+'" data-instance="'+escapeHtml(instanceId||"")+'"'+
    ' style="position:fixed;top:calc(env(safe-area-inset-top,0px) + 16px);left:calc(50% - 91px);z-index:2147483000">'+
    '<summary aria-label="Open WebRPG menu" title="WebRPG">'+
    '<span class="wr-logo"><img src="'+LOGO_URL+'" alt="" decoding="sync">'+
    '<span class="wr-logo-fallback" aria-hidden="true">WR</span></span>'+
    '<span class="wr-label"><strong>WebRPG</strong><small>'+escapeHtml(title||"Playing a game")+'</small></span></summary>'+
    '<nav class="wr-menu" aria-label="WebRPG game navigation">'+
    navLink(HOME_URL,HOME_ICON,"WebRPG home")+detail+
    actionIcon("fullscreen",FULL_ICON,"Enter fullscreen")+
    actionIcon("rotation",ROTATE_ICON,"Request landscape",true)+
    actionIcon("gamepad",PAD_ICON,"Show virtual controls",true)+'</nav>'+
    '<span class="wr-notice" role="status" aria-live="polite" hidden></span></details>'+
    buildControls()+
    '<script src="'+SHELL_JS_URL+'"></script>';
}
export function injectGameShell(html, { entry, match = null } = {}) {
  if (typeof html !== "string") return { html, changed:false, status:"invalid-html" };
  const headMatch=/<head\b[^>]*>/i.exec(html);
  const bodyMatch=/<body\b[^>]*>/i.exec(html);
  if (!headMatch || !bodyMatch || headMatch.index >= bodyMatch.index || !/<\/head\s*>/i.test(html))
    return { html, changed:false, status:"no-head-or-body" };
  const nl=newlineOf(html);
  const slug=match?.slug && SLUG.test(match.slug) ? match.slug : "";
  const title=(match?.instance?.title||entry?.title||"").replace(/\s+/g," ").trim().slice(0,160);
  const htmlLang=(/<html\b[^>]*\blang\s*=\s*["']?([a-zA-Z-]+)\b/i.exec(html)||[])[1]||"";
  const detailLocale=["en","ja","zh-Hans"].includes(htmlLang) ? htmlLang : "en";
  const headBlock=SHELL_HEAD_START+nl+'<link rel="stylesheet" href="'+SHELL_CSS_URL+'">'+nl+SHELL_HEAD_END;
  const bodyBlock=SHELL_BODY_START+nl+buildShell({
    title,gameSlug:slug,instanceId:entry?.id||"",detailLocale,
  })+nl+SHELL_BODY_END;
  const previousHead=replaceRegion(html,SHELL_HEAD_START,SHELL_HEAD_END,headBlock);
  if(previousHead.error) return {html,changed:false,status:previousHead.error};
  const previousBody=replaceRegion(previousHead.html,SHELL_BODY_START,SHELL_BODY_END,bodyBlock);
  if(previousBody.error) return {html,changed:false,status:previousBody.error};
  let next=previousBody.html;
  // Existing managed blocks are replaced IN PLACE without adding whitespace.
  if (!previousHead.found) next=next.replace(/<\/head\s*>/i,nl+headBlock+nl+"</head>");
  if (!previousBody.found) next=next.replace(/<body\b[^>]*>/i,tag=>tag+nl+bodyBlock+nl);
  return { html:next,changed:next!==html,status:next===html?"unchanged":"enhanced",gameSlug:slug||null };
}
